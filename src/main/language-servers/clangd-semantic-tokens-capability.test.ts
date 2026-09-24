import { describe, expect, it } from 'vitest'
import { buildClangdInitializeParams } from './clangd-protocol'

describe('buildClangdInitializeParams — semanticTokens capability (S5)', () => {
  const params = buildClangdInitializeParams('D:\\repo', 1234) as {
    capabilities?: {
      textDocument?: {
        semanticTokens?: {
          dynamicRegistration: boolean
          requests: { range: boolean; full: boolean }
          tokenTypes: string[]
          tokenModifiers: string[]
          formats: string[]
        }
      }
    }
  }

  it('declares the semanticTokens capability with the spike shape', () => {
    const sem = params.capabilities?.textDocument?.semanticTokens
    expect(sem).toBeDefined()
    expect(sem?.dynamicRegistration).toBe(false)
    // range:false, full:true — the spike uses full only (clangd supports delta
    // but the client requests whole-document tokens).
    expect(sem?.requests).toEqual({ range: false, full: true })
    expect(sem?.formats).toEqual(['relative'])
  })

  it('declares the ≥5 identifier-class token types the acceptance criteria color', () => {
    const types = params.capabilities?.textDocument?.semanticTokens?.tokenTypes ?? []
    expect(types).toEqual(
      expect.arrayContaining(['function', 'type', 'variable', 'macro', 'enumMember'])
    )
    expect(types.length).toBeGreaterThanOrEqual(5)
  })

  it('declares at least the declaration/definition modifiers', () => {
    const mods = params.capabilities?.textDocument?.semanticTokens?.tokenModifiers ?? []
    expect(mods).toEqual(expect.arrayContaining(['declaration', 'definition']))
  })
})
