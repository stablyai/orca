import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const scripts = import.meta.dirname
const rows = JSON.parse(readFileSync(path.join(scripts, 'locale-ko-bootstrap-reviewed.json')))

test('Korean bootstrap guards reviewed keys without contaminating the English cache', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ko-bootstrap-')))
  try {
    const dir = path.join(root, 'config/scripts/locale-catalog')
    const locales = path.join(root, 'src/renderer/src/i18n/locales')
    mkdirSync(path.dirname(dir), { recursive: true })
    mkdirSync(locales, { recursive: true })
    cpSync(scripts, dir, { recursive: true })
    const table = path.join(dir, 'locale-ko-bootstrap-reviewed.json')
    const source = path.join(locales, 'en.json')
    const cache = path.join(locales, '.ko-catalog-cache.json')
    const output = path.join(locales, 'ko.json')
    const preload = path.join(root, 'fetch.mjs')
    writeFileSync(
      preload,
      "globalThis.fetch = async (url) => { const u = new URL(url); if (u.searchParams.get('q') !== 'n/a') throw Error('unexpected fetch'); return { ok: true, json: async () => [[['ordinary provider']]] } }\n"
    )
    const run = () =>
      spawnSync(
        process.execPath,
        ['--import', preload, path.join(dir, 'bootstrap-locale-catalog.mjs'), '--locale', 'ko'],
        { cwd: root, encoding: 'utf8' }
      )
    const fixtureRows = [
      { key: 'one', en: 'workflow #', ko: '첫째' },
      { key: 'two', en: 'workflow #', ko: '둘째' },
      { key: 'guarded', en: 'n/a', ko: '해당 없음' }
    ]
    writeFileSync(table, JSON.stringify(fixtureRows))
    writeFileSync(
      source,
      JSON.stringify({ one: 'workflow #', two: 'workflow #', guarded: 'n/a', ordinary: 'n/a' })
    )
    writeFileSync(cache, '{}')
    let result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(output))).toEqual({
      one: '첫째',
      two: '둘째',
      guarded: '해당 없음',
      ordinary: 'ordinary provider'
    })
    expect(JSON.parse(readFileSync(cache))).toEqual({ 'n/a': 'ordinary provider' })
    const first = readFileSync(output, 'utf8')
    result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(first)
    writeFileSync(source, JSON.stringify({ one: 'changed', renamed: 'workflow #' }))
    writeFileSync(cache, JSON.stringify({ changed: '새 번역', 'workflow #': '일반 번역' }))
    result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(output))).toEqual({ one: '새 번역', renamed: '일반 번역' })
    const before = readFileSync(cache, 'utf8')
    writeFileSync(table, JSON.stringify([fixtureRows[0], fixtureRows[0]]))
    result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('duplicate')
    expect(readFileSync(cache, 'utf8')).toBe(before)
    for (const row of [
      { key: 'one', en: 'Hello {{name}}', ko: '안녕' },
      { key: 'one', en: 'Hello <term>world</term>', ko: '안녕 <term>세계' },
      { key: 'one', en: 'Hello', ko: '안녕 <extra>세계</extra>' },
      { key: 'one', en: 'Hello', ko: '' }
    ]) {
      writeFileSync(table, JSON.stringify([row]))
      result = run()
      expect(result.status).not.toBe(0)
      expect(readFileSync(cache, 'utf8')).toBe(before)
    }
    writeFileSync(table, JSON.stringify([{ key: 'one', en: 'Refresh', ko: '다른 번역' }]))
    writeFileSync(source, JSON.stringify({ one: 'Refresh' }))
    result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('conflicts with translation policy')
    writeFileSync(
      table,
      JSON.stringify([
        { key: 'one', en: '<term>{{x}} {{x}}</term>', ko: '<term>{{x}} {{x}}</term>' },
        { key: 'two', en: 'Orca', ko: '가짜' },
        { key: 'auto.components.status.bar.StatusBar.6d1042aa6f', en: 'test pin', ko: '가짜' }
      ])
    )
    writeFileSync(
      source,
      JSON.stringify({
        one: '<term>{{x}} {{x}}</term>',
        two: 'Orca',
        auto: { components: { status: { bar: { StatusBar: { '6d1042aa6f': 'test pin' } } } } }
      })
    )
    writeFileSync(cache, JSON.stringify({ 'test pin': 'cached' }))
    result = run()
    expect(result.status, result.stderr).toBe(0)
    const pinned = JSON.parse(readFileSync(output))
    expect(pinned.one).toBe('<term>{{x}} {{x}}</term>')
    expect(pinned.two).toBe('Orca')
    expect(pinned.auto.components.status.bar.StatusBar['6d1042aa6f']).toContain('사용량 구간')
    expect(rows).toHaveLength(27)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
