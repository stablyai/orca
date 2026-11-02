import { provisionWslClaudeAccountProfile } from './claude-profile-wsl-setup'

// Runs in the distro: `<guest home> <distro> <account id> <hooks enabled>`.
async function main(): Promise<void> {
  const [userHome = '', distro = '', accountId = '', hooks = 'false'] = process.argv.slice(2)
  const report = await provisionWslClaudeAccountProfile(
    userHome,
    distro,
    accountId,
    hooks === 'true'
  )
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
