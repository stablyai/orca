// Pure tree model for the mobile file explorer: turns the flat files.list
// result into a nested directory structure and flattens it into renderable
// rows. Kept out of the screen component so the screen stays under its line cap.

export type MobileFileEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type FilesListResult = {
  files: MobileFileEntry[]
  totalCount: number
  truncated: boolean
}

export type TreeNode = {
  id: string
  name: string
  relativePath: string
  depth: number
  kind: 'directory' | 'text' | 'binary'
}

export type DirectoryNode = {
  name: string
  relativePath: string
  directories: Map<string, DirectoryNode>
  files: MobileFileEntry[]
}

function createDirectoryNode(name: string, relativePath: string): DirectoryNode {
  return { name, relativePath, directories: new Map(), files: [] }
}

export function buildTree(files: MobileFileEntry[]): DirectoryNode {
  const root = createDirectoryNode('', '')
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean)
    let current = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!
      const relativePath = parts.slice(0, index + 1).join('/')
      let child = current.directories.get(name)
      if (!child) {
        child = createDirectoryNode(name, relativePath)
        current.directories.set(name, child)
      }
      current = child
    }
    current.files.push(file)
  }
  return root
}

export function flattenTree(root: DirectoryNode, expanded: ReadonlySet<string>): TreeNode[] {
  const rows: TreeNode[] = []
  const visit = (directory: DirectoryNode, depth: number): void => {
    const dirs = Array.from(directory.directories.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const child of dirs) {
      rows.push({
        id: `dir:${child.relativePath}`,
        name: child.name,
        relativePath: child.relativePath,
        depth,
        kind: 'directory'
      })
      if (expanded.has(child.relativePath)) {
        visit(child, depth + 1)
      }
    }
    const files = [...directory.files].sort((a, b) => a.basename.localeCompare(b.basename))
    for (const file of files) {
      rows.push({
        id: `file:${file.relativePath}`,
        name: file.basename,
        relativePath: file.relativePath,
        depth,
        kind: file.kind
      })
    }
  }
  visit(root, 0)
  return rows
}

export function isMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}
