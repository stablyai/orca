import { provisionClaudeAccountProfile } from './claude-profile-setup'
import { wslClaudeProfile } from './claude-profile-wsl-paths'

// Runs inside a WSL distro on Orca's pinned Node: `<guest home> <distro> <account id>`.
// Hooks are not installed here: they reach the account through the settings copy from ~/.claude.
async function main(): Promise<void> {
  const [userHome = '', distro = '', accountId = ''] = process.argv.slice(2)
  const { dataRoot, profile } = wslClaudeProfile(userHome, distro, accountId)
  const report = await provisionClaudeAccountProfile({
    dataRoot,
    profile,
    userHome,
    installHooks: null
  })
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
