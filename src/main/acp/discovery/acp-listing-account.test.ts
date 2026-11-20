import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { prepareAcpListingAccount } from './acp-listing-account'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("writes Orca's chat home settings for the saved method before a listing, as a chat start does", async () => {
  root = mkdtempSync(join(tmpdir(), 'acp-listing-account-'))
  const home = join(root, 'antigravity-chat')
  const env = { GEMINI_HOME: home, HOME: root, GEMINI_API_KEY: 'key' }
  await prepareAcpListingAccount(
    acpLaunchSpecFor('antigravity')!,
    env,
    { method: 'gemini-api-key' },
    () => {}
  )
  expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"gemini-api-key"}}'
  )
})

it('lists nothing for a key method without a key, as for a signed-out agent', async () => {
  root = mkdtempSync(join(tmpdir(), 'acp-listing-account-'))
  const env = { GEMINI_HOME: join(root, 'antigravity-chat'), HOME: root }
  await expect(
    prepareAcpListingAccount(
      acpLaunchSpecFor('antigravity')!,
      env,
      { method: 'gemini-api-key' },
      () => {}
    )
  ).rejects.toBeInstanceOf(AgentModelCatalogUnavailableError)
})
