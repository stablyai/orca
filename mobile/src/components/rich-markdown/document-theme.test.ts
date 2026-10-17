// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { applyMobileColorScheme, lightColors, darkColors } from '../../theme/mobile-theme'
import { applyRichMarkdownEditorTheme } from './document-theme'

afterEach(() => applyMobileColorScheme('dark'))
it('updates editor colors without replacing the draft or selection target', () => {
  const root = document.createElement('div')
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.textContent = 'Unsent draft'
  root.appendChild(editor)
  document.body.appendChild(root)
  try {
    applyMobileColorScheme('light')
    applyRichMarkdownEditorTheme(root)
    expect(root.style.getPropertyValue('--background')).toBe(lightColors.bgBase)
    expect(root.style.getPropertyValue('color-scheme')).toBe('light')
    applyMobileColorScheme('dark')
    applyRichMarkdownEditorTheme(root)
    expect(root.style.getPropertyValue('--background')).toBe(darkColors.bgBase)
    expect(root.firstChild).toBe(editor)
    expect(editor.textContent).toBe('Unsent draft')
  } finally {
    root.remove()
  }
})
