import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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

it('never refuses a listing, even with no key and a saved Google login', async () => {
  root = mkdtempSync(join(tmpdir(), 'acp-listing-account-'))
  const home = join(root, 'antigravity-chat')
  mkdirSync(join(home, 'antigravity-acp'), { recursive: true })
  writeFileSync(join(home, 'antigravity-acp', 'acp_token.json'), '{}')
  await expect(
    prepareAcpListingAccount(
      acpLaunchSpecFor('antigravity')!,
      { GEMINI_HOME: home, HOME: root },
      { method: 'gemini-api-key' },
      () => {}
    )
  ).resolves.toBeUndefined()
})

it('never fails a listing whose account files cannot be prepared, as before', async () => {
  root = mkdtempSync(join(tmpdir(), 'acp-listing-account-'))
  // gcloud with no project anywhere: a chat start says so; a listing goes on.
  await expect(
    prepareAcpListingAccount(
      acpLaunchSpecFor('antigravity')!,
      {
        GEMINI_HOME: join(root, 'antigravity-chat'),
        HOME: root,
        CLOUDSDK_CONFIG: join(root, 'none')
      },
      { method: 'agent-platform' },
      () => {}
    )
  ).resolves.toBeUndefined()
})
