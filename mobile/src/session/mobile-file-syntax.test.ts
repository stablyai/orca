import { describe, expect, it } from 'vitest'
import { detectMobileFileLanguage } from './mobile-file-language'
import {
  buildPlainMobileDiffSyntaxLines,
  highlightMobileCode,
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from './mobile-file-syntax'
import type { MobileDiffLine } from './mobile-diff-lines'

describe('mobile file syntax highlighting', () => {
  it('detects common source languages from file paths', () => {
    expect(detectMobileFileLanguage('src/App.tsx')).toBe('typescript')
    expect(detectMobileFileLanguage('scripts/deploy.sh')).toBe('shell')
    expect(detectMobileFileLanguage('Dockerfile')).toBe('dockerfile')
    expect(resolveMobileSyntaxLanguage('src/App.tsx')).toBe('typescript')
    expect(resolveMobileSyntaxLanguage('Dockerfile')).toBe('plaintext')
  })

  it('emits semantic syntax segments for highlighted code', () => {
    const result = highlightMobileCode('const label: string = "Orca"', 'typescript')

    expect(result.highlighted).toBe(true)
    expect(result.segments).toEqual(
      expect.arrayContaining([
        { text: 'const', kind: 'keyword' },
        { text: 'string', kind: 'type' },
        { text: '"Orca"', kind: 'string' }
      ])
    )
  })

  it('preserves diff line state while highlighting code inside the line', () => {
    const lines: MobileDiffLine[] = [
      { kind: 'delete', text: 'const oldLabel = "Old"', oldLineNumber: 4 },
      { kind: 'add', text: 'const newLabel = "New"', newLineNumber: 4 }
    ]

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted[0]?.kind).toBe('delete')
    expect(highlighted[0]?.oldLineNumber).toBe(4)
    expect(highlighted[0]?.segments).toContainEqual({ text: 'const', kind: 'keyword' })
    expect(highlighted[1]?.kind).toBe('add')
    expect(highlighted[1]?.newLineNumber).toBe(4)
    expect(highlighted[1]?.segments).toContainEqual({ text: '"New"', kind: 'string' })
  })

  it('continues highlighting after blank diff lines', () => {
    const lines: MobileDiffLine[] = [
      { kind: 'context', text: "import { readFileSync } from 'node:fs'", newLineNumber: 1 },
      { kind: 'context', text: '', newLineNumber: 2 },
      { kind: 'context', text: 'const projectDir = dirname(import.meta.url)', newLineNumber: 3 }
    ]

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted[1]).toMatchObject({
      highlighted: false,
      segments: [{ text: '', kind: 'plain' }]
    })
    expect(highlighted[2]?.segments).toContainEqual({ text: 'const', kind: 'keyword' })
  })

  it('falls back to plain text when segment caps would create too many React Native nodes', () => {
    const result = highlightMobileCode('const label: string = "Orca"', 'typescript', 1_000, 1)

    expect(result.highlighted).toBe(false)
    expect(result.segments).toEqual([{ text: 'const label: string = "Orca"', kind: 'plain' }])
  })

  it('caps highlighted diff lines and keeps later rows renderable as plain text', () => {
    const lines: MobileDiffLine[] = Array.from({ length: 520 }, (_, index) => ({
      kind: 'add',
      text: `const value${index} = "mobile"`,
      newLineNumber: index + 1
    }))

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted).toHaveLength(520)
    expect(highlighted.filter((line) => line.highlighted)).toHaveLength(500)
    expect(highlighted[519]).toEqual({
      ...lines[519],
      highlighted: false,
      segments: [{ text: lines[519]!.text, kind: 'plain' }]
    })
  })

  it('stops attempting diff highlighting after a token-dense line exceeds the segment cap', () => {
    const denseLine = Array.from(
      { length: 120 },
      (_, index) => `const value${index}: string = "${index}"`
    ).join('; ')
    const highlighted = highlightMobileDiffLines(
      [
        { kind: 'add', text: denseLine, newLineNumber: 1 },
        { kind: 'add', text: 'const later = "plain"', newLineNumber: 2 }
      ] satisfies MobileDiffLine[],
      'typescript'
    )

    expect(highlighted[0]?.highlighted).toBe(false)
    expect(highlighted[1]).toMatchObject({
      highlighted: false,
      segments: [{ text: 'const later = "plain"', kind: 'plain' }]
    })
  })

  it('builds plain diff syntax rows without changing diff metadata', () => {
    const lines: MobileDiffLine[] = [{ kind: 'delete', text: 'plain', oldLineNumber: 9 }]

    expect(buildPlainMobileDiffSyntaxLines(lines)).toEqual([
      {
        ...lines[0],
        highlighted: false,
        segments: [{ text: 'plain', kind: 'plain' }]
      }
    ])
  })
})
