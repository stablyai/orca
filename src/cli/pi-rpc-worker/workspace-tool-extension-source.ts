export function buildWorkspaceToolExtensionSource(): string {
  return String.raw`const WORKSPACE_READ_OUTPUT_MAX_BYTES = 64 * 1024;

function boundedToolText(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= WORKSPACE_READ_OUTPUT_MAX_BYTES) {
    return { text: value, truncated: false };
  }
  const suffix = "\n[Output truncated at the secure workspace tool limit]";
  const budget = WORKSPACE_READ_OUTPUT_MAX_BYTES - Buffer.byteLength(suffix, "utf8") - 3;
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, budget));
  return { text: text + suffix, truncated: true };
}

function registerWorkspaceTools(pi: ExtensionAPI, getWorkspaceRoot: () => string) {
  pi.registerTool({
    name: "read",
    label: "Read Workspace File",
    description: "Read one UTF-8 regular file inside the workspace. Absolute paths, links, non-regular files, files over 1 MiB, and output over 64 KiB are rejected or bounded.",
    promptSnippet: "Read a bounded UTF-8 file confined to the workspace",
    promptGuidelines: ["Use read only with relative workspace paths."],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }))
    }, strict),
    async execute(_id, params) {
      const content = await readWorkspaceText(getWorkspaceRoot(), params.path);
      const lines = content.split("\n");
      const start = (params.offset ?? 1) - 1;
      const selected = lines.slice(start, start + (params.limit ?? 2000)).join("\n");
      const bounded = boundedToolText(selected);
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details: { path: params.path, startLine: start + 1, truncated: bounded.truncated }
      };
    }
  });

  pi.registerTool({
    name: "list",
    label: "List Workspace Directory",
    description: "List at most 256 entries in one real directory inside the workspace without following links. Link, hardlink, and non-regular entries are reported only as blocked names.",
    promptSnippet: "List bounded entries in a workspace directory",
    promptGuidelines: ["Use list only with relative workspace directory paths."],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 }))
    }, strict),
    async execute(_id, params) {
      const result = await listWorkspaceEntries(
        getWorkspaceRoot(),
        params.path ?? ".",
        params.maxItems ?? 256
      );
      const lines = result.entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((entry) => entry.kind + "\t" + JSON.stringify(entry.name));
      if (result.truncated) lines.push("[Directory listing truncated at the item limit]");
      const bounded = boundedToolText(lines.join("\n"));
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details: { path: params.path ?? ".", items: result.entries.length, truncated: result.truncated }
      };
    }
  });

  pi.registerTool({
    name: "write",
    label: "Write Workspace File",
    description: "Atomically write at most 1 MiB to a relative workspace path. Parent links, target links/hardlinks, and non-regular targets are rejected; parent directories must already exist.",
    promptSnippet: "Atomically write a bounded UTF-8 workspace file",
    promptGuidelines: ["Use write only with relative workspace paths and bounded content."],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      content: Type.String({ maxLength: 1048576 })
    }, strict),
    async execute(_id, params) {
      await writeWorkspaceText(getWorkspaceRoot(), params.path, params.content);
      return {
        content: [{ type: "text" as const, text: "Workspace file written atomically." }],
        details: { path: params.path, bytes: Buffer.byteLength(params.content, "utf8") }
      };
    }
  });

  pi.registerTool({
    name: "edit",
    label: "Edit Workspace File",
    description: "Atomically apply up to 64 unique, non-overlapping exact replacements to one bounded UTF-8 regular workspace file. Links, hardlinks, races detected before commit, and non-regular files are rejected.",
    promptSnippet: "Atomically edit a bounded UTF-8 workspace file using exact replacements",
    promptGuidelines: ["Use edit with relative workspace paths and unique exact oldText matches."],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      edits: Type.Array(Type.Object({
        oldText: Type.String({ minLength: 1, maxLength: 1048576 }),
        newText: Type.String({ maxLength: 1048576 })
      }, strict), { minItems: 1, maxItems: 64 })
    }, strict),
    async execute(_id, params) {
      await editWorkspaceText(getWorkspaceRoot(), params.path, params.edits);
      return {
        content: [{ type: "text" as const, text: "Workspace edits committed atomically." }],
        details: { path: params.path, edits: params.edits.length }
      };
    }
  });
}
`
}
