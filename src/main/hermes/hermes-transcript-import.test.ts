import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HERMES_TRANSCRIPT_IMPORT } from './hermes-transcript-import'

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
  root = null
})

async function candidatePaths(selected: string): Promise<string[]> {
  const homes = await HERMES_TRANSCRIPT_IMPORT.accountHomeCandidates({
    settings: {},
    selectedAccountHome: { variable: 'HERMES_HOME', path: selected }
  })
  return homes.flatMap((home) => ('path' in home ? [home.path] : []))
}

it('looks for a Hermes conversation in every profile, and in the root only while bare hermes runs it', async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-hermes-import-'))
  const work = join(root, 'profiles', 'work')
  const ops = join(root, 'profiles', 'ops')
  mkdirSync(work, { recursive: true })
  mkdirSync(ops, { recursive: true })

  expect(await candidatePaths(root)).toEqual([root, ops, work])

  // After `hermes profile use work`, `hermes acp` under the root runs work's store instead.
  writeFileSync(join(root, 'active_profile'), 'work\n')
  expect(await candidatePaths(work)).toEqual([work, ops])
})
