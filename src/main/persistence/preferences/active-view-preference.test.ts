// The saved view never holds one of this run only (a share request's page): set refuses it, keeping the
// last saved view, and a file holding one reads as unsaved.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ActiveViewPreference, getActiveViewPreferenceFile } from './active-view-preference'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function dataFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-active-view-'))
  dirs.push(dir)
  return join(dir, 'orca-data.json')
}

it('never saves a share request’s page, keeping the view saved before it', () => {
  const file = dataFile()
  const preference = new ActiveViewPreference(file, undefined)
  expect(preference.set('settings')).toBe(true)
  expect(preference.set('shareRequest')).toBe(false)
  preference.flushOrThrow()
  expect(preference.get()).toBe('settings')
  expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(file), 'utf-8'))).toEqual({
    activeView: 'settings'
  })
})

it('reads a saved share request’s page as nothing saved', () => {
  const file = dataFile()
  writeFileSync(getActiveViewPreferenceFile(file), '{"activeView":"shareRequest"}\n')
  expect(new ActiveViewPreference(file, 'shareRequest').get()).toBe('terminal')
})
