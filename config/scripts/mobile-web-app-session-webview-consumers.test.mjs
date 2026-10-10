/** Session routes resolve the named components to their web implementations. */
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

/** Web implementations expected in the session route closure. */
const ANSWERED = [
  'src/components/MobileRichMarkdownEditor.web.tsx',
  'src/components/MobileHtmlPreview.web.tsx',
  'src/components/pr-sidebar/MermaidDiagram.web.tsx',
  'src/terminal/TerminalWebView.web.tsx'
]

describeClosure(
  'the session route web component closure',
  () => {
    it('includes all four web components in the session route closure', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local.length).toBeGreaterThan(500)
      for (const file of ANSWERED) {
        expect(closure.local, file).toContain(file)
      }
    })

    it('resolves all four web components and excludes their native files', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      for (const file of ANSWERED) {
        expect(closure.local, file).toContain(file)
        expect(closure.local, file).not.toContain(file.replace('.web.tsx', '.tsx'))
      }
    })
  },
  240_000
)
