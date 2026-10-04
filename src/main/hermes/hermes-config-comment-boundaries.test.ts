import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'
import { HermesHookService } from './hook-service'

const fixtures = [
  ...['  ', '    '].flatMap((indent) =>
    [true, false].map((retained) => ({
      name: `trailing list comment (${indent.length} spaces, retained: ${retained})`,
      list: `${indent}# list head\n${retained ? `${indent}- keep\n` : ''}${indent}- orca-status # managed entry\n${indent}# list tail\n`,
      suffix: '  custom: "off"\nmodel: "001"\n'
    }))
  ),
  {
    name: 'comment before the next root setting',
    list: '    - keep\n    - orca-status # managed entry\n',
    suffix: '# Operator notes\nmodel: "001"\n'
  },
  {
    name: 'comment before the next plugin setting',
    list: '    - keep\n    - orca-status # managed entry\n',
    suffix: '  # Plugin notes\n  custom: "off"\nmodel: "001"\n'
  },
  {
    name: 'comment at the end of the document',
    list: '    - keep\n    - orca-status # managed entry\n',
    suffix: '# End notes\n'
  },
  {
    name: 'leading comment on the first retained entry',
    list: '    # lead\n    - orca-status\n    # between\n    - keep\n',
    suffix: 'model: "001"\n'
  }
]

describe.each(['\n', '\r\n'])('Hermes comment boundaries (%j)', (eol) => {
  describe.each(['install', 'remove'])('%s', (operation) => {
    it.each(fixtures)('preserves $name exactly once through the service', async (fixture) => {
      const key = operation === 'install' ? 'disabled' : 'enabled'
      const enabled = operation === 'install' ? '  enabled: [orca-status]\n' : ''
      const input = `plugins:\n${enabled}  ${key}:\n${fixture.list}${fixture.suffix}`.replaceAll(
        '\n',
        eol
      )
      const updater = operation === 'install' ? enablePlugin : disablePlugin
      const result = updateConfigContent(input, updater)
      expect(result.detail).toBeUndefined()
      const output = result.content ?? ''
      const parsed = parseDocument(output)
      expect(parsed.errors).toEqual([])
      expect(parsed.warnings).toEqual([])
      expect(parsed.toJS()).toEqual(updater(parseDocument(input).toJS()))
      for (const comment of input.match(/#[^\r\n]*/g) ?? []) {
        expect(output.split(comment)).toHaveLength(2)
      }
      expect(output.endsWith(fixture.suffix.replaceAll('\n', eol))).toBe(true)
      expect(updateConfigContent(output, updater).content).toBe(output)
      if (eol === '\r\n') {
        expect(output.replaceAll(eol, '')).not.toContain('\n')
      }

      const root = mkdtempSync(join(tmpdir(), 'orca-hermes-comments-'))
      const home = join(root, '.hermes')
      mkdirSync(home)
      const path = join(home, 'config.yaml')
      vi.stubEnv('HERMES_HOME', home)
      try {
        writeFileSync(path, input)
        const service = new HermesHookService()
        const status = operation === 'install' ? service.install() : service.remove()
        expect(status.state).toBe(operation === 'install' ? 'installed' : 'not_installed')
        expect(readFileSync(path, 'utf8')).toBe(output)
        expect(readFileSync(`${path}.bak`, 'utf8')).toBe(input)
        if (operation === 'install') {
          writeFileSync(path, input)
          const remote = await service.installRemote(createManagedHookLocalFilesystem(), root)
          expect(remote.state).toBe('installed')
          expect(readFileSync(path, 'utf8')).toBe(output)
        }
      } finally {
        vi.unstubAllEnvs()
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
