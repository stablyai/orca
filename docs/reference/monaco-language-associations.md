# Monaco filename associations

Orca imports Monaco's full `editor.main.js` entry point, which registers the built-in
languages and loads their grammars on demand. Filename detection must not load the
editor itself: it also runs during session restoration and before the editor mounts.

`monaco-language-associations.json` contains the registration metadata from the
installed package's entry point, plus curated Ruby associations in the generator.
Those add `.rake`, `.ru`, `.jbuilder`, `.thor`, `Guardfile`, `Capfile`, `Podfile`,
`Brewfile` and `Vagrantfile` to the existing Ruby grammar. Change these in
`config/scripts/generate-monaco-associations.mjs`, not the generated JSON.
Regenerate after changing the curated associations or upgrading Monaco:

```sh
node config/scripts/generate-monaco-associations.mjs
pnpm exec oxfmt --write src/renderer/src/lib/monaco-language-associations.json
```

The generator reads syntax trees without executing contributions or grammar loaders.
Its test compares the checked-in metadata to the installed package and curated associations. The original
list was verified against a clone of `microsoft/monaco-editor`, tag `v0.55.1`, commit
`516f350bdaf7a82f6731bd128a9ec86a6e5fa47d` (`src/basic-languages` and `src/language`).

Existing Orca filename and extension choices take precedence. This preserves custom
Vue, Svelte, Astro, Nim, Typst, JSONL, notebook and preview handling, as well as the
Markdown mapping for MDX. The fallback matches exact filenames before the longest
extension, case-insensitively, and resolves duplicate associations in upstream
registration order (the last registration wins, so `.pp` selects Ruby over Pascal).

Monaco 0.55.1 has 90 registrations, 81 with filenames or extensions. Registrations
without either remain available in Monaco but cannot be inferred from a path. This
does not add VS Code extensions or language servers, guess from file contents, or
change mobile's separate lowlight grammar set. The renderer uses only the basename,
so local, Windows, SSH and folder-workspace paths share the same detection.
