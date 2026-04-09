# Design: Mermaid Diagrams & Code Copy Button

## Overview

Add two markdown features to Orca that both Clearly and Superset already support:

1. **Mermaid diagram rendering** in preview mode (and read-only display in rich mode)
2. **Code copy button** on code blocks in preview mode

---

## 1. Mermaid Diagrams

### Scope

Render ` ```mermaid ` fenced code blocks as SVG diagrams in **preview mode**. In **rich mode**, mermaid blocks remain editable as regular code blocks (with `mermaid` as the language label) — no live rendering.

### Approach

Use `mermaid` (npm package) to render diagrams client-side in the React preview.

**Preview mode** (`MarkdownPreview.tsx`):
- Add a custom `code` component override in the `components` map
- When a code block has `className="language-mermaid"` (set by rehype-highlight/remark), render it via mermaid instead of as highlighted code
- Create a `<MermaidBlock content={code} />` component that:
  - Calls `mermaid.render()` in a `useEffect`
  - Injects the resulting SVG via `dangerouslySetInnerHTML`
  - Shows the raw source as fallback on parse error
  - Respects dark/light theme (read `isDark` from context or prop, configure mermaid theme accordingly)

**Rich mode** (`RichMarkdownCodeBlock.tsx`):
- No changes needed. Mermaid blocks already show as code blocks with `mermaid` in the language selector. Users edit the source directly.

**Rich-mode detection** (`markdown-rich-mode.ts`):
- No changes needed. Mermaid blocks are standard fenced code blocks — they don't trigger any unsupported-syntax fallback.

### New files

| File | Purpose |
|---|---|
| `src/renderer/src/components/editor/MermaidBlock.tsx` | React component that renders a mermaid string to SVG |

### Dependencies

```
pnpm add mermaid
```

### Key decisions

- **Client-side rendering only** — no server/main-process involvement. Mermaid JS runs in the renderer.
- **Lazy init** — call `mermaid.initialize()` once on first render, not at import time, to avoid slowing startup.
- **Theme sync** — pass `{ theme: isDark ? 'dark' : 'default' }` to `mermaid.initialize()`. Re-render when theme changes.
- **Error handling** — on invalid mermaid syntax, render the raw source in a code block with an error banner above it. Don't break the rest of the preview.
- **Unique IDs** — mermaid requires a unique container ID per diagram. Use `useId()` or a counter.

### Changes to existing files

**`MarkdownPreview.tsx`**:
```tsx
// Add to the components map:
code: ({ className, children, ...props }) => {
  const match = /language-mermaid/.exec(className || '')
  if (match) {
    return <MermaidBlock content={String(children).trimEnd()} isDark={isDark} />
  }
  // Wrap non-mermaid code blocks for the copy button (see section 2)
  return <code className={className} {...props}>{children}</code>
}
```

**`main.css`**:
```css
/* Mermaid diagram container */
.mermaid-block svg {
  max-width: 100%;
  height: auto;
}
.mermaid-error {
  color: var(--color-warning);
  font-size: 0.85em;
  margin-bottom: 0.5em;
}
```

---

## 2. Code Copy Button

### Scope

Show a "Copy" button on hover over code blocks in **preview mode**. Clicking it copies the code content to the clipboard.

### Approach

Add a wrapper component around `<pre>` blocks in the preview's `components` map that renders a positioned copy button.

**Preview mode** (`MarkdownPreview.tsx`):
- Add a `pre` component override that wraps the native `<pre>` in a container with `position: relative`
- Render a copy button (`position: absolute; top-right`) that appears on hover
- On click, extract text from `children`, write to clipboard via `navigator.clipboard.writeText()`
- Show brief "Copied!" feedback (swap icon or text for ~1.5s)

### New files

| File | Purpose |
|---|---|
| `src/renderer/src/components/editor/CodeBlockCopyButton.tsx` | The `<pre>` wrapper with copy button |

### Dependencies

None — uses `navigator.clipboard` and existing lucide-react icons (`Copy`, `Check`).

### Key decisions

- **Preview-only** — the rich editor already has its own editing UX; a copy button there would conflict with text selection.
- **Button appears on hover** — hidden by default, fades in on `.code-block-wrapper:hover`. Always visible on touch devices via `@media (hover: none)`.
- **Icon-only** — small `Copy` icon (lucide), swaps to `Check` icon after click. No text label to keep it unobtrusive.
- **Mermaid blocks excluded** — diagrams don't get a copy button (the rendered SVG isn't useful to copy as text).

### Changes to existing files

**`MarkdownPreview.tsx`**:
```tsx
// Add to the components map:
pre: ({ children, ...props }) => (
  <CodeBlockCopyButton {...props}>{children}</CodeBlockCopyButton>
)
```

**`main.css`**:
```css
.code-block-wrapper {
  position: relative;
}
.code-block-copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.code-block-wrapper:hover .code-block-copy-btn {
  opacity: 1;
}
```

---

## Implementation plan

1. **Code copy button** — smaller scope, no new dependency, ship first
2. **Mermaid diagrams** — add dependency, build `MermaidBlock`, wire into preview

Both features are preview-mode only and touch the same file (`MarkdownPreview.tsx`) but are independent of each other.
