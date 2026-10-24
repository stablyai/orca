// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useActivePluginIconTheme } from '@/store/plugin-icon-themes'
import { FileTypeIcon, FolderIcon } from './FileTypeIcon'

afterEach(() => {
  cleanup()
  useActivePluginIconTheme.setState({ theme: null })
})

it('uses built-in icons until a plugin icon theme is active', () => {
  const { container } = render(<FileTypeIcon filePath="src/app.ts" className="size-3" />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('[data-plugin-icon]')).toBeNull()
})

it('prefers a file name, then an extension, then the theme file icon, by shared icon index', () => {
  useActivePluginIconTheme.setState({
    theme: {
      icons: { file: 0, folder: 1 },
      fileNames: { 'readme.md': 2 },
      fileExtensions: { ts: 3 }
    }
  })
  const icon = (path: string) =>
    render(<FileTypeIcon filePath={path} className="size-3" />)
      .container.querySelector('[data-plugin-icon]')
      ?.getAttribute('data-plugin-icon')

  expect(icon('docs/README.md')).toBe('2')
  expect(icon('src/app.TS')).toBe('3')
  expect(icon('Makefile')).toBe('0')
  expect(
    render(<FolderIcon open={false} />)
      .container.querySelector('[data-plugin-icon]')
      ?.getAttribute('data-plugin-icon')
  ).toBe('1')
  expect(render(<FolderIcon open />).container.querySelector('svg')).not.toBeNull()
})
