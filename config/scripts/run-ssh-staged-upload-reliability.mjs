import { spawnSync } from 'node:child_process'

const defaultFiles = [
  'src/main/ssh/sftp-upload.test.ts',
  'src/main/ssh/ssh-file-transfer-abort.test.ts',
  'src/main/ssh/ssh-relay-deploy-staged-upload.test.ts',
  'src/main/ssh/ssh-relay-native-deps-install-staged-upload.test.ts',
  'src/main/ssh/ssh-relay-sftp-namespace-install.test.ts',
  'src/main/ssh/ssh-relay-install-namespace.test.ts',
  'src/main/ssh/ssh-relay-upload-stage-commands.test.ts',
  'src/main/ssh/sftp-namespace-resolution.test.ts',
  'src/main/ssh/ssh-connection-sftp-wire.test.ts',
  'src/main/ssh/ssh-remote-commands.test.ts',
  'src/main/ssh/ssh-relay-cross-version-isolation.test.ts'
]

const cliArguments = process.argv.slice(2)
const powerShellFlag = cliArguments.indexOf('--powershell')
const configuredPowerShell =
  powerShellFlag >= 0 ? cliArguments[powerShellFlag + 1] : process.env.ORCA_POWERSHELL_EXECUTABLE
if (powerShellFlag >= 0 && !configuredPowerShell) {
  console.error('--powershell requires an executable path')
  process.exit(2)
}
const powerShellExecutable = [
  configuredPowerShell,
  ...(process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'])
].find((candidate) => {
  if (!candidate) {
    return false
  }
  return (
    spawnSync(
      candidate,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { encoding: 'utf8' }
    ).status === 0
  )
})
if (!powerShellExecutable) {
  console.error('A native PowerShell executable is required')
  process.exit(2)
}
const powerShellVersion = spawnSync(
  powerShellExecutable,
  ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  { encoding: 'utf8' }
).stdout.trim()
console.log(`SSH staged-upload reliability: PowerShell ${powerShellVersion}`)
const requestedFiles = cliArguments.filter(
  (_argument, index) => index !== powerShellFlag && index !== powerShellFlag + 1
)
const files = requestedFiles.length > 0 ? requestedFiles : defaultFiles

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    ...files,
    '--maxWorkers=1',
    '--reporter=dot'
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORCA_POWERSHELL_EXECUTABLE: powerShellExecutable
    },
    stdio: 'inherit'
  }
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
