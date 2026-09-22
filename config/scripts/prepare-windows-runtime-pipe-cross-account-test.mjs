import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Cross-account pipe preparation requires Windows.')
}

const root = resolve(import.meta.dirname, '../..')
const authorizedAccount =
  readArgument('--authorized-account') ??
  `${process.env.COMPUTERNAME}\\CodexSandboxOffline`
const handoffPath = resolve(
  readArgument('--handoff') ??
    join(root, 'native', 'windows-runtime-pipe-broker', '.build', 'cross-account-handoff.txt')
)
const nativeDir = join(root, 'native', 'windows-runtime-pipe-broker')
const clientSource = join(nativeDir, 'CrossAccountPipeClient.cs')
const clientOutput = join(nativeDir, '.build', 'cross-account-pipe-client.exe')
const buildScript = join(root, 'config', 'scripts', 'build-windows-runtime-pipe-broker.mjs')
const serverScript = join(
  root,
  'config',
  'scripts',
  'windows-runtime-pipe-cross-account-server.mjs'
)
const windowsDirectory = process.env.WINDIR ?? process.env.SystemRoot
if (!windowsDirectory) throw new Error('Windows directory is unavailable.')
const compiler = [
  join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find(existsSync)
if (!compiler) throw new Error('C# compiler not found.')

run(process.execPath, [buildScript])
mkdirSync(dirname(clientOutput), { recursive: true })
run(compiler, [
  '/nologo',
  '/target:exe',
  '/warnaserror+',
  `/out:${clientOutput}`,
  clientSource
])

const identity = spawnSync(clientOutput, ['identity'], {
  encoding: 'utf8',
  timeout: 5_000,
  windowsHide: true
})
if (identity.error) throw identity.error
if (identity.status !== 0) throw new Error(`Server identity probe exited ${identity.status}.`)
process.stdout.write(identity.stdout)
console.log(`POLICY_SOURCE=LookupAccountNameW LOCAL_USER=${authorizedAccount}`)
console.log('AUTHORIZED_RIGHTS=ReadWrite|Synchronize MASK=0x12019B')
console.log(`CLIENT_COMMAND=& '${clientOutput}' '${handoffPath}'`)
run(process.execPath, [
  serverScript,
  '--authorized-account',
  authorizedAccount,
  '--handoff',
  handoffPath
])

function readArgument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function run(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: 'inherit',
    timeout: null,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${program} exited ${result.status ?? 'without a code'}.`)
  }
}
