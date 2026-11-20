import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discardAntigravityListingSession } from './antigravity-listing-session'

const ID = '0ccc38b2-d200-4c7b-bb9b-e2e82104ad0e'
let home = ''
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('removes the session agy wrote for a model listing, which has no .meta file', async () => {
  home = mkdtempSync(join(tmpdir(), 'agy-listing-'))
  const acp = join(home, 'antigravity-acp')
  mkdirSync(join(acp, 'conversations'), { recursive: true })
  mkdirSync(join(acp, 'brain', ID), { recursive: true })
  writeFileSync(join(acp, 'conversations', `${ID}.db`), '')
  writeFileSync(join(acp, 'conversations', 'other.db'), '')

  await discardAntigravityListingSession({ sessionId: ID, cwd: '/listing', accountHomePath: home })

  expect(existsSync(join(acp, 'conversations', `${ID}.db`))).toBe(false)
  expect(existsSync(join(acp, 'brain', ID))).toBe(false)
  expect(existsSync(join(acp, 'conversations', 'other.db'))).toBe(true)
})
