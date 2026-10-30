import { provisionWslClaudeAccountProfile } from './claude-profile-wsl-provision'

// Runs inside a WSL distro on Orca's pinned Node: `<guest home> <distro> <account id>`.
async function main(): Promise<void> {
  const [userHome = '', distro = '', accountId = ''] = process.argv.slice(2)
  const report = await provisionWslClaudeAccountProfile(userHome, distro, accountId)
  if (report.outcome !== 'prepared') {
    console.error(JSON.stringify(report))
    process.exitCode = 2
  } else if (report.warnings.length > 0) {
    process.stdout.write(JSON.stringify(report))
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
