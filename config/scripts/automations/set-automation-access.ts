import { writeFileSync } from 'node:fs'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { ensureCliAppEnvironment } from '../../../src/cli/runtime/profile/cli-app-environment'

ensureCliAppEnvironment()
const [mode = 'inspect', backup, bots] = process.argv.slice(2)
if (!['inspect', 'enable', 'disable'].includes(mode)) {
  throw new Error('Use inspect, enable or disable')
}
const client = new RuntimeClient(undefined, undefined, null, null)
type Policy = { automationFullAccess?: boolean; fullAccessBotIds?: string[] }
const read = async () => (await client.call<{ settings: Policy }>('settings.get')).result.settings
const previousPolicy = await read()
const previous = previousPolicy.automationFullAccess
const previousBots = previousPolicy.fullAccessBotIds ?? []
console.log(
  JSON.stringify({
    supported: previous !== undefined,
    automationFullAccess: previous ?? null,
    fullAccessBotIds: previousBots
  })
)
if (mode !== 'inspect') {
  if (previous === undefined) {
    throw new Error(
      'This host does not support automationFullAccess; deploy the corrected build first'
    )
  }
  const enabled = mode === 'enable'
  const botIds =
    bots === undefined
      ? previousBots
      : bots === 'none'
        ? []
        : bots.split(',').filter(Boolean).sort()
  if (enabled !== previous || JSON.stringify(botIds) !== JSON.stringify([...previousBots].sort())) {
    if (!backup) {
      throw new Error('Supply a new backup JSON path before changing the policy')
    }
    writeFileSync(
      backup,
      `${JSON.stringify({ at: new Date().toISOString(), automationFullAccess: previous, fullAccessBotIds: previousBots })}\n`,
      { flag: 'wx' }
    )
    await client.call('automation.setPermissionPolicy', {
      expected: previous,
      enabled,
      expectedBotIds: previousBots,
      botIds
    })
    const current = await read()
    if (
      current.automationFullAccess !== enabled ||
      JSON.stringify(current.fullAccessBotIds) !== JSON.stringify(botIds)
    ) {
      throw new Error('Verification differs: inspect the policy before any retry')
    }
    console.log(JSON.stringify({ persisted: enabled, fullAccessBotIds: botIds }))
  }
}
