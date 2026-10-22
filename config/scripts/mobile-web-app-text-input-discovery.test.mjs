import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { modulesDeclaringTextInput } from './mobile-web-app/platform-seams/mobile-web-app-text-input-font-size-seam.mjs'

it('discovers input modules and ignores tests and non-JSX mentions', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-text-input-discovery-'))
  try {
    mkdirSync(join(scratch, 'src/browser'), { recursive: true })
    for (const [name, source] of Object.entries({
      'Planted.tsx': 'export const P = () => <TextInput style={styles.input} />',
      'Planted.test.tsx': 'it("x", () => <TextInput />)',
      'mentions-only.ts': "import { TextInput } from 'react-native' // TextInput, named twice"
    })) {
      writeFileSync(join(scratch, 'src/browser', name), source)
    }
    expect(modulesDeclaringTextInput(scratch, 'src/browser')).toEqual(['src/browser/Planted.tsx'])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
