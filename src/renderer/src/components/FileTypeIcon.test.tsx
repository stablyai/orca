// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTypeIcon } from './FileTypeIcon'
import { ConflictReviewFileTree } from './editor/ConflictReviewFileTree'

const state = vi.hoisted(() => ({ settings: {} as { coloredFileIcons?: boolean } }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

afterEach(() => {
  state.settings = {}
})

describe('FileTypeIcon appearance', () => {
  it.each([false, true])(
    'preserves unresolved conflict color with colored icons set to %s',
    (colored) => {
      state.settings.coloredFileIcons = colored
      const container = document.createElement('div')
      const root = createRoot(container)
      try {
        act(() =>
          root.render(
            <ConflictReviewFileTree
              entries={[
                {
                  path: 'notes.md',
                  conflictKind: 'both_modified',
                  liveEntry: {
                    path: 'notes.md',
                    status: 'modified',
                    area: 'unstaged',
                    conflictStatus: 'unresolved'
                  }
                }
              ]}
              collapsed={false}
              onCollapsedChange={() => {}}
              selectedPath={null}
              onOpenEntry={() => {}}
            />
          )
        )
        expect(container.querySelector<SVGElement>('.lucide-file-markdown')!.style.color).toBe(
          'var(--destructive)'
        )
        expect(container.textContent).toContain('Unresolved')
      } finally {
        act(() => root.unmount())
      }
    }
  )

  it('switches existing icons between monochrome and color without changing their shapes', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const render = () =>
      act(() =>
        root.render(<FileTypeIcon filePath="report.pdf" className="size-3 text-muted-foreground" />)
      )
    try {
      render()
      const shape = container.querySelector('svg')!.innerHTML
      expect(container.querySelector('svg')!.style.color).toBe('')
      state.settings.coloredFileIcons = true
      render()
      expect(container.querySelector('svg')!.style.color).toBe('var(--file-icon-red)')
      expect(container.querySelector('svg')!.innerHTML).toBe(shape)
      state.settings.coloredFileIcons = false
      render()
      expect(container.querySelector('svg')!.style.color).toBe('')
    } finally {
      act(() => root.unmount())
    }
  })

  it('preserves explicit git status colors and leaves unknown files neutral', () => {
    state.settings.coloredFileIcons = true
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      act(() =>
        root.render(
          <FileTypeIcon filePath="report.xlsx" style={{ color: 'var(--git-decoration-deleted)' }} />
        )
      )
      expect(container.querySelector('svg')!.style.color).toBe('var(--git-decoration-deleted)')
      act(() => root.render(<FileTypeIcon filePath="unknown.custom" />))
      expect(container.querySelector('svg')!.style.color).toBe('')
    } finally {
      act(() => root.unmount())
    }
  })
})
