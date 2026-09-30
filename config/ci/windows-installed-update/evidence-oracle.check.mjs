// Offline checks for the evidence oracle; runs anywhere, launches nothing.
import assert from 'node:assert/strict'
import {
  authenticodeScript,
  generationOfImage,
  isRelocatedElectronDaemon,
  isUnder,
  parseAuthenticode,
  parseProcessTable,
  processIdentity,
  processVerdict,
  processesUnder,
  windowsPowerShellSpec
} from './windows-evidence.mjs'

const managed = 'C:\\Users\\r\\AppData\\Local\\Orca\\terminal-daemon-host\\managed-v1'
const hash = 'a'.repeat(64)
const created = '2026-09-29T10:00:00.1234567Z'
const table = parseProcessTable(
  JSON.stringify({
    rows: [
      {
        pid: 10,
        ppid: 1,
        name: 'bun-runtime.exe',
        exe: `${managed}\\bun-${hash}\\bun-runtime.exe`,
        created
      },
      {
        pid: 11,
        ppid: 10,
        name: 'powershell.exe',
        exe: 'C:\\Windows\\System32\\powershell.exe',
        created: ''
      }
    ]
  })
)

assert.equal(parseProcessTable('not json'), null, 'garbled snapshot is not evidence')
assert.equal(parseProcessTable('{"rows":[]}'), null, 'empty snapshot is not evidence')
assert.equal(
  parseProcessTable('{"rows":[{"pid":"x","name":"a"}]}'),
  null,
  'malformed row voids snapshot'
)

const daemon = processIdentity(table, 10)
assert.equal(processVerdict(table, daemon), 'live')
assert.equal(processVerdict(null, daemon), 'unverifiable', 'lost snapshot is never exited')
assert.equal(processVerdict(table, { pid: 99, created }), 'exited')
assert.equal(
  processVerdict(table, { pid: 10, created: '2026-09-29T09:00:00Z' }),
  'exited',
  'reused pid is a different process'
)
assert.equal(
  processVerdict(table, { pid: 11, created }),
  'unverifiable',
  'unreadable creation time is not a verdict'
)
assert.equal(processVerdict(table, null), 'unverifiable')
assert.equal(processIdentity(table, 11), null, 'identity requires creation time')

assert.equal(generationOfImage(`${managed}\\bun-${hash}\\bun-runtime.exe`, managed), `bun-${hash}`)
assert.equal(
  generationOfImage(
    `${managed.toUpperCase()}\\BUN-${hash.toUpperCase()}\\BUN-RUNTIME.EXE`,
    managed
  ),
  `bun-${hash}`
)
assert.equal(
  generationOfImage(`${managed}\\bun-${hash}.repair-2\\bun-runtime.exe`, managed),
  `bun-${hash}.repair-2`
)
assert.equal(generationOfImage(`${managed}\\.bun-staging-x\\bun-runtime.exe`, managed), null)
assert.equal(generationOfImage(`${managed}\\bun-${hash}\\conpty\\OpenConsole.exe`, managed), null)
assert.equal(
  generationOfImage(`${managed}-evil\\bun-${hash}\\bun-runtime.exe`, managed),
  null,
  'prefix sibling is outside'
)
assert.equal(
  generationOfImage('C:\\Program Files\\Orca\\resources\\cli-runtime\\bun-runtime.exe', managed),
  null
)

assert.ok(isUnder(`${managed}\\x`, `${managed}\\`))
assert.ok(!isUnder(managed, managed), 'the root itself is not inside itself')
assert.deepEqual(
  processesUnder(table, [managed]).map((row) => row.pid),
  [10]
)
const legacyHost = 'C:\\Users\\r\\AppData\\Local\\Orca\\daemon-host\\1.4.217'
const legacyRow = {
  exe: `${legacyHost}\\Orca.exe`,
  command: `"${legacyHost}\\Orca.exe" "${legacyHost}\\resources\\app.asar.unpacked\\out\\main\\daemon-entry.js" --socket x`
}
assert.ok(isRelocatedElectronDaemon(legacyRow, legacyHost))
assert.ok(
  !isRelocatedElectronDaemon({ ...legacyRow, exe: 'C:\\Programs\\Orca\\Orca.exe' }, legacyHost),
  'install-dir fork is not the relocated host'
)
assert.ok(
  !isRelocatedElectronDaemon(
    { ...legacyRow, command: `"${legacyHost}\\Orca.exe" --type=renderer` },
    legacyHost
  ),
  'an app process from the host copy is not the daemon'
)
assert.ok(
  !isRelocatedElectronDaemon(legacyRow, `${legacyHost}.1`),
  'another version host is not this owner'
)

// Windows PowerShell 5.1 must not inherit a pwsh 7 PSModulePath, in any casing.
const pwshEnv = {
  SystemRoot: 'D:\\Win',
  PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
  psmodulepath: 'x',
  Path: 'C:\\bin'
}
const spec = windowsPowerShellSpec('Get-Date', pwshEnv, 5_000)
assert.equal(spec.program, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
assert.deepEqual(spec.args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Date'])
assert.deepEqual(spec.env, { SystemRoot: 'D:\\Win', Path: 'C:\\bin' })
assert.equal(spec.timeoutMs, 5_000)
assert.equal(pwshEnv.PSModulePath, 'C:\\Program Files\\PowerShell\\7\\Modules')
for (const arg of spec.args) {
  assert.doesNotMatch(arg, /^-(?:EncodedCommand|ExecutionPolicy|ec|ep)$/iu)
}
const signatureScript = authenticodeScript("C:\\it's\\Orca.exe")
assert.match(signatureScript, /-LiteralPath 'C:\\it''s\\Orca\.exe'/u)
assert.match(signatureScript, /if\(-not \$s\)\{throw/u)
assert.deepEqual(parseAuthenticode('{"status":"Valid","thumbprint":"AB"}\r\n'), {
  status: 'Valid',
  thumbprint: 'AB'
})
assert.throws(() => parseAuthenticode('  \r\n'), /printed nothing/u)
assert.throws(() => parseAuthenticode('{"status":"","thumbprint":""}'), /no status/u)
console.log(
  'Evidence oracle: snapshot integrity, pid-reuse, unverifiable, generation parsing and PowerShell invocation checks passed'
)
