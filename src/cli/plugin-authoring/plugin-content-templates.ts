import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'

// Content-only templates: execution "data", so loading them never needs approval.

export function theme(input: PluginTemplateInput): PluginTemplate {
  const description = 'A dark app theme.'
  return {
    description: 'App color theme (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(input, description, {
        execution: 'data',
        contributes: {
          themes: [{ id: `${input.id}-dark`, title: input.name, path: 'themes/dark.json' }]
        }
      }),
      'themes/dark.json': json({
        schemaVersion: 1,
        base: 'dark',
        tokens: {
          '--background': '#1b1430',
          '--foreground': '#e8e0ff',
          '--primary': '#b48cff',
          '--primary-foreground': '#1b1430'
        },
        tokenColors: [
          { scope: 'comment', settings: { foreground: '#8f84ad', fontStyle: 'italic' } },
          { scope: ['keyword', 'storage'], settings: { foreground: '#ff7ad9' } },
          { scope: 'string', settings: { foreground: '#a8e6a1' } }
        ]
      }),
      'README.md': readme(
        input,
        'An Orca app theme. Edit `themes/dark.json`; omitted tokens are derived from `--background` and `--foreground`.'
      ),
      ...COMMON_FILES
    }
  }
}

export function terminalTheme(input: PluginTemplateInput): PluginTemplate {
  return {
    description: 'Terminal ANSI palette (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(input, 'A dark terminal palette.', {
        execution: 'data',
        contributes: {
          terminalThemes: [{ id: input.id, title: input.name, path: 'terminal/dark.json' }]
        }
      }),
      'terminal/dark.json': json({
        schemaVersion: 1,
        mode: 'dark',
        terminal: {
          background: '#1b1430',
          foreground: '#e8e0ff',
          black: '#2a2142',
          red: '#ff6b8b',
          green: '#a8e6a1',
          yellow: '#ffd479',
          blue: '#82cfff',
          magenta: '#ff7ad9',
          cyan: '#7fe7e0',
          white: '#e8e0ff'
        }
      }),
      'README.md': readme(input, 'An Orca terminal palette. Edit `terminal/dark.json`.'),
      ...COMMON_FILES
    }
  }
}

const FILE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#82cfff" d="M3 1h7l3 3v11H3z"/></svg>\n`
const FOLDER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#ffd479" d="M1 3h5l2 2h7v9H1z"/></svg>\n`
const MARKDOWN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#b48cff" d="M3 1h7l3 3v11H3z"/></svg>\n`

export function iconTheme(input: PluginTemplateInput): PluginTemplate {
  return {
    description: 'File and folder icon theme (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(input, 'File and folder icons.', {
        execution: 'data',
        contributes: {
          iconThemes: [{ id: input.id, title: input.name, path: 'icons/theme.json' }]
        }
      }),
      'icons/theme.json': json({
        schemaVersion: 1,
        icons: {
          file: 'icons/file.svg',
          folder: 'icons/folder.svg',
          'folder-open': 'icons/folder.svg'
        },
        fileNames: { 'readme.md': 'icons/markdown.svg' },
        fileExtensions: { md: 'icons/markdown.svg' }
      }),
      'icons/file.svg': FILE_ICON,
      'icons/folder.svg': FOLDER_ICON,
      'icons/markdown.svg': MARKDOWN_ICON,
      'README.md': readme(
        input,
        'An Orca icon theme. `icons/theme.json` maps slots, file names and extensions to SVG files (paths from the plugin root).'
      ),
      ...COMMON_FILES
    }
  }
}

export function syntax(input: PluginTemplateInput): PluginTemplate {
  const scopeName = `source.${input.id.replace(/[^a-z0-9]/g, '')}`
  const extension = `.${input.id.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'example'}`
  return {
    description: 'TextMate syntax highlighting for a file type (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(input, `Syntax highlighting for ${extension} files.`, {
        execution: 'data',
        contributes: {
          syntaxes: [
            {
              id: input.id,
              title: input.name,
              scopeName,
              path: 'syntaxes/grammar.tmLanguage.json',
              configuration: 'syntaxes/language-configuration.json',
              extensions: [extension]
            }
          ]
        }
      }),
      'syntaxes/grammar.tmLanguage.json': json({
        scopeName,
        patterns: [{ include: '#comments' }, { include: '#strings' }, { include: '#keywords' }],
        repository: {
          comments: { patterns: [{ name: 'comment.line.number-sign', match: '#.*$' }] },
          strings: { patterns: [{ name: 'string.quoted.double', begin: '"', end: '"' }] },
          keywords: {
            patterns: [{ name: 'keyword.control', match: '\\b(if|else|while|return)\\b' }]
          }
        }
      }),
      'syntaxes/language-configuration.json': json({
        comments: { lineComment: '#' },
        brackets: [
          ['{', '}'],
          ['(', ')']
        ],
        autoClosingPairs: [
          { open: '{', close: '}' },
          { open: '(', close: ')' },
          { open: '"', close: '"' }
        ]
      }),
      'README.md': readme(
        input,
        `Syntax highlighting for \`${extension}\` files. Edit the grammar in \`syntaxes/\`.`
      ),
      ...COMMON_FILES
    }
  }
}

export function languagePack(input: PluginTemplateInput): PluginTemplate {
  return {
    description: 'Interface translation (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(input, 'Translates Orca into Brazilian Portuguese.', {
        execution: 'data',
        contributes: {
          languagePacks: [
            { locale: 'pt-BR', path: 'locales/pt-BR.json', displayName: 'Português (Brasil)' }
          ]
        }
      }),
      'locales/pt-BR.json': json({ common: { cancel: 'Cancelar', retry: 'Tentar novamente' } }),
      'README.md': readme(
        input,
        'An Orca language pack. Keys mirror the English catalog of Orca; add translated strings to `locales/pt-BR.json`, or change the locale in `orca-plugin.json`.'
      ),
      ...COMMON_FILES
    }
  }
}
