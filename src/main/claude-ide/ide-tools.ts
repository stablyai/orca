export type Selection = { text: string; filePath: string }
export type OpenEditor = { filePath: string; isDirty: boolean }

export type IdeBridge = {
  openDiff(args: { oldPath: string; newPath: string; newContents: string }): Promise<'keep' | 'reject'>
  openFile(path: string): Promise<void>
  getWorkspaceFolders(): Promise<string[]>
  getCurrentSelection(): Promise<Selection | null>
  getOpenEditors(): Promise<OpenEditor[]>
  checkDocumentDirty(path: string): Promise<boolean>
  saveDocument(path: string): Promise<void>
}

type McpToolResult = { content: { type: 'text'; text: string }[] }

function text(t: string): McpToolResult {
  return { content: [{ type: 'text', text: t }] }
}

// Why: coercing missing args with String(x ?? '') would silently run tools on
// empty/bogus paths; a thrown error surfaces as a proper JSON-RPC tool failure.
function requireStringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') {
      return v
    }
  }
  throw new Error(`Invalid arguments: "${keys[0]}" must be a non-empty string`)
}

export async function handleToolCall(
  bridge: IdeBridge,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  switch (tool) {
    case 'openDiff': {
      const newContents = args.new_file_contents
      const verdict = await bridge.openDiff({
        oldPath: requireStringArg(args, 'old_file_path'),
        newPath: requireStringArg(args, 'new_file_path'),
        // Why: empty string is a legal new-file content, unlike paths.
        newContents: typeof newContents === 'string' ? newContents : '',
      })
      return text(verdict)
    }
    case 'openFile':
      await bridge.openFile(requireStringArg(args, 'filePath', 'path'))
      return text('ok')
    case 'getWorkspaceFolders':
      return text(JSON.stringify(await bridge.getWorkspaceFolders()))
    case 'getCurrentSelection':
      return text(JSON.stringify(await bridge.getCurrentSelection()))
    case 'getOpenEditors':
      return text(JSON.stringify(await bridge.getOpenEditors()))
    case 'checkDocumentDirty':
      return text(JSON.stringify(await bridge.checkDocumentDirty(requireStringArg(args, 'filePath'))))
    case 'saveDocument':
      await bridge.saveDocument(requireStringArg(args, 'filePath'))
      return text('ok')
    default:
      throw new Error(`Unknown tool: ${tool}`)
  }
}
