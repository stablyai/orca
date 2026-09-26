import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `app.exit()` fires neither before-quit nor will-quit, so a relaunch that leaves
 * that way writes no committed-quit crumb. The next launch then reads the deliberate
 * restart as an abrupt whole-app death and backfills `mainProcessDiedAbruptly` onto
 * the reports it left behind — for the GPU-fallback restart, the very reports the GPU
 * crash just created. `relaunchAndExitImmediately` is what keeps the crumb attached to
 * the exit; this fails when a new relaunch site pairs `relaunchApp` with a raw exit
 * instead. Not enforced: an `app.exit()` unrelated to a relaunch, which the quit
 * pipeline never owned in the first place.
 */
const REPOSITORY_ROOT = resolve(__dirname, '..', '..')
const CHOKE_POINT = 'src/main/app-relaunch.ts'
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

function scanSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      scanSourceFiles(path, found)
      continue
    }
    if (entry.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

describe('immediate-exit relaunch choke point', () => {
  it('leaves no relaunch site exiting without the committed-quit crumb', () => {
    const offenders = scanSourceFiles(join(REPOSITORY_ROOT, 'src/main'))
      .map((path) => relative(REPOSITORY_ROOT, path).split('\\').join('/'))
      .filter((path) => path !== CHOKE_POINT)
      .filter((path) => {
        const source = readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
        return /\brelaunchApp\s*\(/.test(source) && /\bapp\.exit\s*\(/.test(source)
      })

    expect(offenders).toEqual([])
  })

  it('still guards something — the choke point itself pairs the two', () => {
    const source = readFileSync(join(REPOSITORY_ROOT, CHOKE_POINT), 'utf8')

    expect(/\brelaunchApp\s*\(/.test(source)).toBe(true)
    expect(/\bapp\.exit\s*\(/.test(source)).toBe(true)
    expect(source).toContain('recordRelaunchExitBreadcrumb()')
  })
})
