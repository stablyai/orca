export type LanguageConfig = {
  languageId: string
  /** key into the grammar-wasm registry (see parser.ts) */
  grammarKey: string
  /** tree-sitter query; capture the defined identifier as @name */
  query: string
}

const TS_QUERY = `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
(class_declaration name: (type_identifier) @name)
(interface_declaration name: (type_identifier) @name)
(type_alias_declaration name: (type_identifier) @name)
(enum_declaration name: (identifier) @name)
(variable_declarator name: (identifier) @name)
(public_field_definition name: (property_identifier) @name)
`

const PY_QUERY = `
(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)
`

const GO_QUERY = `
(function_declaration name: (identifier) @name)
(method_declaration name: (field_identifier) @name)
(type_spec name: (type_identifier) @name)
`

const RUST_QUERY = `
(function_item name: (identifier) @name)
(struct_item name: (type_identifier) @name)
(enum_item name: (type_identifier) @name)
(trait_item name: (type_identifier) @name)
(mod_item name: (identifier) @name)
`

const JAVA_QUERY = `
(class_declaration name: (identifier) @name)
(interface_declaration name: (identifier) @name)
(method_declaration name: (identifier) @name)
(enum_declaration name: (identifier) @name)
`

// NOTE (confirmed against src/renderer/src/lib/language-detect.ts): Orca maps
// .ts AND .tsx onto the single id 'typescript', and .js/.jsx/.mjs/.cjs onto
// 'javascript'. There is no 'typescriptreact' id. The `tsx` tree-sitter grammar
// parses .ts/.js/.jsx/.tsx alike, so both ids use grammarKey 'tsx'.
const CONFIGS: Record<string, LanguageConfig> = {
  typescript: { languageId: 'typescript', grammarKey: 'tsx', query: TS_QUERY },
  javascript: { languageId: 'javascript', grammarKey: 'tsx', query: TS_QUERY },
  python: { languageId: 'python', grammarKey: 'python', query: PY_QUERY },
  go: { languageId: 'go', grammarKey: 'go', query: GO_QUERY },
  rust: { languageId: 'rust', grammarKey: 'rust', query: RUST_QUERY },
  java: { languageId: 'java', grammarKey: 'java', query: JAVA_QUERY }
}

export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.keys(CONFIGS)

export function getLanguageConfig(languageId: string): LanguageConfig | null {
  return CONFIGS[languageId] ?? null
}
