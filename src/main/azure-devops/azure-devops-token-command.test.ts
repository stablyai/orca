import { expect, it } from 'vitest'
import { runAzureDevOpsTokenCommand } from './azure-devops-token-command'

const node = JSON.stringify(process.execPath)

it('reads the first printed line as the token and never puts it in the environment', async () => {
  const token = await runAzureDevOpsTokenCommand(
    `${node} -e "process.stdout.write('\\n  token-from-keychain  \\nsecond')"`
  )
  expect(token).toBe('token-from-keychain')
  expect(Object.values(process.env)).not.toContain('token-from-keychain')
})

it('treats a failing or silent command as no token', async () => {
  expect(await runAzureDevOpsTokenCommand(`${node} -e "process.exit(3)"`)).toBeNull()
  expect(await runAzureDevOpsTokenCommand(`${node} -e ""`)).toBeNull()
})
