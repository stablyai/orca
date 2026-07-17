'use strict'

function deadline(label, timeoutMs) {
  let timeout
  const promise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs)
  })
  return { promise, cancel: () => clearTimeout(timeout) }
}

async function runSshRelayRuntimePtySmoke({
  nodePty,
  runtimeRequire,
  runtimeRoot,
  platform = process.platform,
  environment = process.env,
  timeoutMs = 15_000
}) {
  const windows = platform === 'win32'
  const executable = windows
    ? 'powershell.exe'
    : environment.SHELL && environment.SHELL.startsWith('/')
      ? environment.SHELL
      : '/bin/sh'
  const arguments_ = windows
    ? [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        "$ErrorActionPreference='Stop';" +
          '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' +
          "Write-Output 'ORCA_PTY_READY';" +
          '$line=[Console]::ReadLine();' +
          '$size=$Host.UI.RawUI.WindowSize;' +
          'Write-Output ("ORCA_PTY_SIZE:{0}x{1}" -f $size.Width,$size.Height);' +
          'Write-Output ("ORCA_PTY_INPUT:{0}" -f $line);' +
          'exit 23'
      ]
    : [
        '-c',
        'printf "ORCA_PTY_READY\\n"; IFS= read -r line; stty size; printf "ORCA_PTY_INPUT:%s\\n" "$line"; exit 23'
      ]
  const terminal = nodePty.spawn(executable, arguments_, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: runtimeRoot,
    env: environment,
    useConpty: windows,
    // Why: the relay uses the bundled ConPTY runtime to preserve terminal rendering behavior.
    useConptyDll: windows
  })
  let output = ''
  let wroteInput = false
  const outputSubscription = terminal.onData((data) => {
    output += data
    if (!wroteInput && output.includes('ORCA_PTY_READY')) {
      wroteInput = true
      terminal.resize(101, 37)
      terminal.write('bounded-marker\r')
    }
  })
  let exitSubscription
  let limitSubscription
  const exited = new Promise((resolve, reject) => {
    exitSubscription = terminal.onExit(resolve)
    limitSubscription = terminal.onData(() => {
      if (output.length > 1024 * 1024) {
        reject(new Error('PTY smoke output exceeded 1 MiB'))
      }
    })
  })
  const timer = deadline('PTY smoke', timeoutMs)
  let result
  let cleanupStarted = false
  function settlePtyResources() {
    if (cleanupStarted) {
      return
    }
    cleanupStarted = true
    try {
      outputSubscription.dispose()
      exitSubscription.dispose()
      limitSubscription.dispose()
    } finally {
      if (!result || windows) {
        // Why: node-pty retains its Windows ConPTY worker handles after process exit until kill().
        terminal.kill()
      }
    }
  }
  try {
    result = await Promise.race([exited, timer.promise])
    if (
      result.exitCode !== 23 ||
      !output.includes('ORCA_PTY_INPUT:bounded-marker') ||
      !output.includes(windows ? 'ORCA_PTY_SIZE:101x37' : '37 101')
    ) {
      throw new Error(
        `PTY smoke mismatch: exit=${result.exitCode} output=${JSON.stringify(output)}`
      )
    }
    const { loadNativeModule } = runtimeRequire('node-pty/lib/utils')
    const nativeNames = windows ? ['conpty', 'conpty_console_list'] : ['pty']
    const nativeDirectories = nativeNames.map((name) => loadNativeModule(name).dir)
    if (
      nativeDirectories.some(
        (directory) => !directory.replaceAll('\\', '/').includes('build/Release/')
      )
    ) {
      throw new Error(
        `node-pty did not load patched build/Release artifacts: ${nativeDirectories.join(', ')}`
      )
    }
    return {
      exitCode: result.exitCode,
      resizedRows: 37,
      resizedColumns: 101,
      nativeDirectory: nativeDirectories.join(', ')
    }
  } finally {
    timer.cancel()
    settlePtyResources()
  }
}

module.exports = { runSshRelayRuntimePtySmoke }
