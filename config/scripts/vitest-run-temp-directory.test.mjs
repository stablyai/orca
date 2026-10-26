import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createRunTempDirectory,
  resolveRunTempBase,
  sweepStaleRunDirectories
} from './vitest-run-temp-directory.mjs'

const bases = []

function makeBase() {
  const base = mkdtempSync(join(tmpdir(), 'orca-run-temp-'))
  bases.push(base)
  return base
}

function runDirectory(base, pid, marked) {
  const path = join(base, `ov${pid.toString(36)}`)
  mkdirSync(path)
  if (marked) {
    writeFileSync(join(path, '.orca-vitest-run'), '')
  }
  return path
}

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true })
  }
})

it('sweeps only marked run directories whose launcher is dead', () => {
  const base = makeBase()
  const dead = runDirectory(base, 101, true)
  const live = runDirectory(base, 102, true)
  const foreign = runDirectory(base, 103, false)
  sweepStaleRunDirectories(base, { ownPid: 1, alive: (pid) => pid === 102 })
  expect([existsSync(dead), existsSync(live), existsSync(foreign)]).toEqual([false, true, true])
})

it('removes the run directory and leaves an unmarked one with the same name alone', () => {
  const base = makeBase()
  const run = createRunTempDirectory({ base, pid: 104 })
  writeFileSync(join(run.path, 'leaked'), '')
  expect(run.env).toEqual({ TMPDIR: run.path, TEMP: run.path, TMP: run.path })
  run.remove()
  expect(existsSync(run.path)).toBe(false)

  runDirectory(base, 105, false)
  expect(createRunTempDirectory({ base, pid: 105 })).toBeNull()
})

it('keeps POSIX run roots no longer than the default macOS temp root', () => {
  const macTemp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000gn/T'
  expect(resolveRunTempBase(macTemp, 'ov255r', 'darwin')).toBe('/tmp')
  expect(resolveRunTempBase('/tmp', 'ov255r', 'linux')).toBe('/tmp')
  expect(resolveRunTempBase('C:\\Users\\a\\AppData\\Local\\Temp', 'ov255r', 'win32')).toBe(
    'C:\\Users\\a\\AppData\\Local\\Temp'
  )
})
