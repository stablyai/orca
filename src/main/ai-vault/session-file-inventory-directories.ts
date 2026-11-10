import { dirname } from 'node:path'
import { isInsideSessionRoot } from './session-file-discovery'

export type SessionInventoryDirectory = { files: Set<string>; children: Set<string> }

export class SessionInventoryDirectories extends Map<string, SessionInventoryDirectory> {
  constructor(private readonly root: string) {
    super()
  }

  addFile(path: string): void {
    let child = path
    let directory = dirname(child)
    while (isInsideSessionRoot(this.root, directory)) {
      const node = this.get(directory) ?? { files: new Set<string>(), children: new Set<string>() }
      if (child === path) {
        node.files.add(child)
      } else {
        node.children.add(child)
      }
      this.set(directory, node)
      if (directory === this.root) {
        break
      }
      child = directory
      directory = dirname(directory)
    }
  }

  removeTree(
    path: string,
    removeFile: (path: string) => void,
    removeDirectory?: (path: string) => void
  ): void {
    const directory = this.get(path)
    if (!directory) {
      return
    }
    for (const file of directory.files) {
      removeFile(file)
    }
    for (const child of directory.children) {
      this.removeTree(child, removeFile, removeDirectory)
    }
    this.delete(path)
    removeDirectory?.(path)
  }
}
