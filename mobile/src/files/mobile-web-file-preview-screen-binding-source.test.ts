import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeRoute = readFileSync(
  new URL('../../app/h/[hostId]/files/preview/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/files/preview/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(new URL('./MobileFilePreviewScreen.tsx', import.meta.url), 'utf8')

describe('mobile web file preview screen binding', () => {
  it('mounts the existing preview with strict injected operations', () => {
    expect(nativeRoute).toContain('export function MobileFilePreviewRoute(')
    expect(presentation).toContain('defaultHostFilePreviewOperations(')
    expect(presentation).not.toContain('loadMobileFilePreview(')
    expect(presentation).not.toContain('saveMobileTerminalArtifactPreview(')
    expect(hostedRoute).toContain(
      "import { MobileFilePreviewRoute } from '../../../../../app/h/[hostId]/files/preview/[worktreeId]'"
    )
    expect(hostedRoute).toContain('webHostFilePreviewOperations(shell.client)')
    expect(hostedRoute).toContain('operations={operations}')
    expect(hostedRoute).toContain('nativeHostBinding={false}')
    expect(hostedRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })
})
