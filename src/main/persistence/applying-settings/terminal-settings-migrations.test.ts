import { expect, it } from 'vitest'
import { stripRetiredGlobalSettings } from './terminal-settings-migrations'

it("drops only an Antigravity Command whose program is Orca's deleted agy copy", () => {
  const orcaCopies = [
    '/Users/me/Library/Application\\ Support/orca/agent-runtimes/agy/1.5.16/agy',
    '"/home/me/.config/orca/agent-runtimes/agy/1.5.16/agy" --verbose',
    'NO_COLOR=1 /home/me/.config/orca/agent-runtimes/agy/1.5.16/agy',
    '& "C:\\Users\\me\\AppData\\Roaming\\orca\\agent-runtimes\\agy\\1.5.16\\agy.exe"'
  ]
  for (const antigravity of orcaCopies) {
    const stored = {
      agentCmdOverrides: { antigravity, claude: '/opt/claude' },
      antigravityManagedAgyEnabled: false
    }
    expect(stripRetiredGlobalSettings(stored)).toEqual({
      agentCmdOverrides: { claude: '/opt/claude' }
    })
  }
  for (const antigravity of [
    '/Users/me/.local/bin/agy',
    'agy --log-file /tmp/agent-runtimes/agy/1.5.16/agy'
  ]) {
    const own = { agentCmdOverrides: { antigravity } }
    expect(stripRetiredGlobalSettings(own)).toEqual(own)
  }
})
