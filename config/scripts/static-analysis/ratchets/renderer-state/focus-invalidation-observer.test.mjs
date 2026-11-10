import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countFocusSettingReads } from './check-focus-read-ratchet.mjs'
import { omitFocusInvalidationReaderUses } from './focus-invalidation-observer.mjs'

const rel = 'src/renderer/src/store/terminals/terminal-membership-route-domains.ts'
const source = fs.readFileSync(rel, 'utf8')
const reader = 'getSingleFocusedRuntimeEnvironmentId'
const readers = new Set([reader])
const count = (text, file = rel) =>
  countFocusSettingReads(omitFocusInvalidationReaderUses(file, text), readers)
const observe = `${reader}(previous) !==\n          ${reader}(state)`

describe('focus dependency observation', () => {
  it('excludes only the verified invalidation calls and retains extra reader uses', () => {
    expect(count(source)).toBe(0)
    expect(count(`${source}\nconst extra = ${reader}(state)`)).toBe(1)
    expect(count(`${source}\nfunction target(s) { return ${reader}(s) }`)).toBe(1)
    expect(count(`${source}\nforward(${reader}(state))`)).toBe(1)
    expect(count(source, 'src/renderer/src/other.ts')).toBe(2)
  })

  it('counts routing, action gates and escaped or non-setup dependency sets', () => {
    const mutations = [
      source.replace(
        'return {\n    forget,',
        "forget = (workspace: string): void => { void window.api.pty.kill('pty-to-close') }; return {\n    forget,"
      ),
      source.replace('return {\n    forget,', 'refresh = replacement; return {\n    forget,'),
      source.replace('return {\n    forget,', '({ forget } = replacements); return {\n    forget,'),
      source.replace('return {\n    forget,', 'escape(refresh, forget); return {\n    forget,'),
      source.replace(
        'forget(workspace)\n    catalogs.',
        'forget(workspace)\n    dispatch(state)\n    catalogs.'
      ),
      source.replace('owners.set(workspace, owner)', 'owners.set(workspace, focusRoute(state))'),
      source.replace('return owner\n  }', 'return focusRoute(state)\n  }'),
      source.replace('owners.delete(workspace)', 'dispatch(workspace); owners.delete(workspace)'),
      source.replace('addAll(setups)', 'dispatch(setups)'),
      source.replace('addAll(setups)', 'return state'),
      source.replace('addAll(setups)', 'addAll(setups); dispatch()'),
      source.replace(observe, `(${reader}(previous) !== ${reader}(state)) && allowed()`),
      source.replace(observe, `(chosen = ${reader}(previous)) !== ${reader}(state)`),
      source.replace('setups.add(workspace)', 'setups.add(otherWorkspace)'),
      source.replace('if (setup) {', 'if (true) {'),
      source.replace('setups.delete(workspace)', 'escape(setups)'),
      source.replace('const setups = new Set<string>()', 'const setups = externalSet'),
      source.replace(
        'for (const id of ids) {\n          affected.add(id)',
        'for (const id of ids) {\n          dispatch(id)'
      ),
      source.replace('refresh(state, id)', 'dispatch(state, id)'),
      source.replace(
        "const owner = resolveTerminalPtyOwner(state, workspace, 'spawn')",
        'const owner = focusRoute(state)'
      ),
      source.replace(
        "from '@/lib/workspace/ownership/single-runtime-legacy-owner'",
        "from './lookalike'"
      ),
      source.replace('const catalogs =', `const ${reader} = anotherReader; const catalogs =`),
      source.replace('return affected', 'escape(affected); return affected'),
      source.replace('const addAll =', 'escape(setups); const addAll =')
    ]
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source)
      expect(count(mutated), `mutation ${mutations.indexOf(mutated)}`).toBeGreaterThanOrEqual(2)
    }
  })
})
