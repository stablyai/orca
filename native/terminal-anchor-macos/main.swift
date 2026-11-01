import Darwin

// Gives one terminal its own macOS "responsible process", the identity the kernel hands to every
// descendant at spawn. Clearing the environment, double-forking and setsid do not change it, so it
// answers "which terminal started this?" for processes that no longer carry Orca's tag.
//
// launch <node> <entry> <worktree-id> <terminal-handle> <file> [args...]
//   Runs as the PTY's session leader. Starts the anchor, then waits for it to report the shell's
//   exit, because the anchor itself stays alive for as long as anything still names it.
// exec-foreground <file> [args...]
//   Runs in the shell's place under the anchor: takes the terminal's foreground in a process group
//   of its own, leaving the launcher and anchor in the root's group, then becomes <file>.
// count-responsible <pid>
//   How many other processes name <pid> as their responsible process.
// origin <pid>
//   The responsible process of <pid>, and the terminal it anchors if it is an anchor.

// Private calls, looked up at run time: a macOS without them must still get a working terminal.
private func privateCall<Function>(_ name: String, as type: Function.Type) -> Function? {
  let defaultSearch = UnsafeMutableRawPointer(bitPattern: -2)
  return dlsym(defaultSearch, name).map { unsafeBitCast($0, to: type) }
}

private let disclaimResponsibility = privateCall(
  "responsibility_spawnattrs_setdisclaim",
  as: (@convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32).self)

private let responsiblePid = privateCall(
  "responsibility_get_pid_responsible_for_pid", as: (@convention(c) (pid_t) -> pid_t).self)

private let statusFd: Int32 = 3
private let anchorEntryName = "terminal-anchor-entry.js"

private func fail(_ message: String, code: Int32 = 127) -> Never {
  fputs("orca-terminal-anchor: \(message)\n", stderr)
  exit(code)
}

private func exec(_ command: ArraySlice<String>) -> Never {
  var cArguments: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) }
  cArguments.append(nil)
  execv(command.first!, cArguments)
  fail("could not start \(command.first!): \(String(cString: strerror(errno)))")
}

/// False when the anchor cannot start, which the caller answers by running the shell without one.
private func spawnAnchor(
  executable: String, entry: String, identity: ArraySlice<String>, command: ArraySlice<String>,
  statusWriteEnd: Int32
) -> Bool {
  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  for descriptor: Int32 in [0, 1, 2] {
    posix_spawn_file_actions_addinherit_np(&actions, descriptor)
  }
  posix_spawn_file_actions_adddup2(&actions, statusWriteEnd, statusFd)

  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  var noSignals = sigset_t()
  sigemptyset(&noSignals)
  var allSignals = sigset_t()
  sigfillset(&allSignals)
  posix_spawnattr_setsigmask(&attributes, &noSignals)
  posix_spawnattr_setsigdefault(&attributes, &allSignals)
  posix_spawnattr_setflags(
    &attributes,
    Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
  // The one call that matters: the anchor is its own responsible process, so its descendants name it.
  guard disclaimResponsibility?(&attributes, 1) == 0 else { return false }

  let argv =
    [executable, entry, CommandLine.arguments[0], String(statusFd)] + identity + command
  var cArguments: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
  cArguments.append(nil)
  defer { cArguments.forEach { free($0) } }

  // The host may be plain Node or Electron; both run an entry script with this set. The anchor
  // removes it again before starting the shell.
  var cEnvironment: [UnsafeMutablePointer<CChar>?] = [strdup("ELECTRON_RUN_AS_NODE=1")]
  var entryPointer = environ
  while let variable = entryPointer.pointee {
    if strncmp(variable, "ELECTRON_RUN_AS_NODE=", 21) != 0 {
      cEnvironment.append(strdup(variable))
    }
    entryPointer += 1
  }
  cEnvironment.append(nil)
  defer { cEnvironment.forEach { free($0) } }

  var pid: pid_t = 0
  return posix_spawn(&pid, executable, &actions, &attributes, cArguments, cEnvironment) == 0
}

private func launch(_ arguments: ArraySlice<String>) -> Never {
  let parts = Array(arguments)
  guard parts.count >= 5 else {
    fail("launch needs <node> <entry> <worktree-id> <terminal-handle> <file> [args...]", code: 64)
  }
  var ends: [Int32] = [0, 0]
  guard pipe(&ends) == 0,
    spawnAnchor(
      executable: parts[0], entry: parts[1], identity: parts[2...3], command: parts[4...],
      statusWriteEnd: ends[1])
  else {
    exec(parts[4...])
  }
  close(ends[1])

  // Until the shell takes the foreground, a Ctrl-C reaches this group. A hangup still ends this
  // process: that is how closing the terminal reaches everything else.
  for signalNumber in [SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU] {
    signal(signalNumber, SIG_IGN)
  }

  var report: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 64)
  while true {
    let count = read(ends[0], &chunk, chunk.count)
    if count > 0 {
      report.append(contentsOf: chunk[0..<count])
      if report.contains(10) { break }
    } else if count == 0 || errno != EINTR {
      break
    }
  }
  let fields = String(decoding: report, as: UTF8.self).split(whereSeparator: { $0 == " " || $0 == "\n" })
  guard fields.count == 2, let code = Int32(fields[0]), let signalNumber = Int32(fields[1]) else {
    fail("the anchor ended before the shell did", code: 1)
  }
  if signalNumber > 0 {
    signal(signalNumber, SIG_DFL)
    kill(getpid(), signalNumber)
    exit(128 + signalNumber)
  }
  exit(code)
}

private func execForeground(_ arguments: ArraySlice<String>) -> Never {
  guard !arguments.isEmpty else { fail("exec-foreground needs a file", code: 64) }
  setpgid(0, 0)
  // tcsetpgrp from a background group raises SIGTTOU. Without a terminal it fails, harmlessly.
  signal(SIGTTOU, SIG_IGN)
  tcsetpgrp(0, getpgrp())
  signal(SIGTTOU, SIG_DFL)
  exec(arguments)
}

private func allPids() -> [pid_t] {
  let capacity = Int(proc_listallpids(nil, 0)) + 64
  var pids = [pid_t](repeating: 0, count: max(capacity, 64))
  let count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.stride)))
  return Array(pids.prefix(max(count, 0))).filter { $0 > 0 }
}

private func parsePid(_ text: String?) -> pid_t {
  guard let text, let pid = pid_t(text), pid > 0 else { fail("expected a pid", code: 64) }
  return pid
}

private func countResponsible(_ pid: pid_t) -> Never {
  let me = getpid()
  var count = 0
  for candidate in allPids() where candidate != pid && candidate != me {
    if responsiblePid?(candidate) == pid { count += 1 }
  }
  print(count)
  exit(0)
}

/// Exec path and argv of a process. Only argv is read, never its environment.
private func readArgv(_ pid: pid_t) -> [String]? {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 1_048_576
  var buffer = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > 4 else { return nil }
  let argc = buffer.withUnsafeBytes { Int($0.load(as: Int32.self)) }
  var index = 4
  while index < size, buffer[index] != 0 { index += 1 }
  while index < size, buffer[index] == 0 { index += 1 }
  var argv: [String] = []
  while argv.count < argc, index < size {
    let begin = index
    while index < size, buffer[index] != 0 { index += 1 }
    argv.append(String(decoding: buffer[begin..<index], as: UTF8.self))
    index += 1
  }
  return argv
}

private func jsonString(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    default:
      if scalar.value < 0x20 {
        out += "\\u00" + (scalar.value < 16 ? "0" : "") + String(scalar.value, radix: 16)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

private func printOrigin(_ pid: pid_t) -> Never {
  guard let responsible = responsiblePid?(pid) else {
    fail("this macOS has no responsible process call")
  }
  var fields = ["\"pid\":\(pid)", "\"responsiblePid\":\(responsible)"]
  if let argv = readArgv(responsible), argv.count > 5, argv[1].hasSuffix(anchorEntryName) {
    fields.append("\"worktreeId\":\(jsonString(argv[4]))")
    fields.append("\"terminalHandle\":\(jsonString(argv[5]))")
  }
  print("{" + fields.joined(separator: ",") + "}")
  exit(0)
}

let commandArguments = CommandLine.arguments
guard commandArguments.count >= 2 else { fail("expected a command", code: 64) }
switch commandArguments[1] {
case "launch": launch(commandArguments[2...])
case "exec-foreground": execForeground(commandArguments[2...])
case "count-responsible":
  countResponsible(parsePid(commandArguments.count > 2 ? commandArguments[2] : nil))
case "origin": printOrigin(parsePid(commandArguments.count > 2 ? commandArguments[2] : nil))
default: fail("unknown command \(commandArguments[1])", code: 64)
}
