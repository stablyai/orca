# Plugin syntax highlighting

A plugin adds highlighting for a language through `contributes.syntaxes` in `orca-plugin.json`:

```json
{
  "id": "typst",
  "label": "Typst",
  "scopeName": "source.typst",
  "path": "syntaxes/typst.tmLanguage.json",
  "configuration": "syntaxes/language-configuration.json",
  "extensions": [".typ"],
  "filenames": []
}
```

- `path` is a TextMate grammar in JSON (at most 1 MiB) whose `scopeName` matches the entry.
  Keys the TextMate engine does not use are dropped.
- `include` may name `#repository` entries, `$self`, `$base`, or another `syntaxes` scope in the
  same plugin; those must resolve when the plugin is approved, or its card shows the error. An
  include of a scope outside the plugin (for example an embedded `source.js`) is allowed but
  resolves to nothing, so that region stays plain.
- `configuration` (optional, at most 64 KiB) sets comment markers, brackets, auto-closing and
  surrounding pairs.
- A plugin can contribute up to 16 syntaxes. Scope names must be unique within the plugin.

## How Orca uses it

- A plugin syntax applies only to files Orca would otherwise show as plain text. An exact file
  name wins over an extension, and a longer extension wins over a shorter one. There is no
  per-file override yet, so a plugin that claims a broad extension such as `.txt` highlights every
  such file while it is enabled.
- Grammars load when a matching file opens, compile once in a worker, and stay warm while you
  type. Each line has the same limits as Orca's own grammars (1,000 characters, 50 ms); from a
  line that exceeds them, the rest of the file stays plain.
- Highlighting is applied as Monaco semantic tokens, so while a new pass runs the previous colors
  stay in place, shifted by your edits.
- A worker that stops reporting progress for 2 seconds or crashes is terminated, the language stays
  plain, and the plugin card says highlighting stopped.
- Files over 500,000 characters or 20,000 lines stay plain.
- Highlighting follows the plugin live: enabling, updating or disabling it re-highlights open
  files without a reload.
