import { describe, expect, it } from 'vitest'
import { assessProcessHostImports } from './check-process-host-imports.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

function specifiers(contents) {
  return collectModuleSpecifiers('file.ts', contents)
}

describe('static module specifiers', () => {
  it.each([
    [
      'a direct createRequire call',
      "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('child_process')"
    ],
    [
      'an assigned createRequire loader',
      "import { createRequire } from 'node:module'\nconst load = createRequire(__filename)\nload('node:child_process')"
    ],
    [
      'a renamed createRequire import',
      "import { createRequire as make } from 'module'\nconst load = make(__filename)\nload.resolve('child_process')"
    ],
    [
      'a namespace createRequire',
      "import * as nodeModule from 'node:module'\nnodeModule.createRequire(__filename)('child_process')"
    ],
    [
      'a default-import createRequire',
      "import Module from 'module'\nconst load = Module.createRequire(__filename)\nload('child_process')"
    ],
    [
      'a named default-import createRequire',
      "import { default as Module } from 'node:module'\nModule.createRequire(__filename)('child_process')"
    ],
    [
      'a named Module constructor',
      "import { Module } from 'node:module'\nModule.createRequire(__filename)('child_process')"
    ],
    [
      'a renamed Module constructor',
      "import { Module as HostModule } from 'module'\nHostModule.createRequire(__filename)('node:child_process')"
    ],
    [
      'an import-equals createRequire',
      "import Module = require('node:module')\nconst load = Module.createRequire(__filename)\nload('node:child_process')"
    ],
    [
      'a literal-property createRequire',
      "import * as Module from 'node:module'\nModule['createRequire'](__filename)('child_process')"
    ],
    [
      'a required createRequire',
      "const { createRequire: make } = require('node:module')\nmake(__filename)('child_process')"
    ],
    [
      'a quoted destructured createRequire',
      "const { 'createRequire': make } = require('node:module')\nmake(__filename)('child_process')"
    ],
    [
      'a chained module alias',
      "const nodeModule = require('module')\nconst load = nodeModule.createRequire(__filename)\nload('child_process')"
    ],
    [
      'an awaited module import',
      "const { createRequire } = await import('node:module')\ncreateRequire(import.meta.url)('child_process')"
    ],
    ['a reassigned require', "const load = require\nload('child_process')"],
    ['module.require', "module.require('child_process')"],
    ['a literal-property module.require', "module['require']('child_process')"],
    ['a literal-property require.resolve', "require['resolve']('child_process')"],
    ['process.getBuiltinModule', "process.getBuiltinModule('node:child_process')"],
    ['a literal-property getBuiltinModule', "process['getBuiltinModule']('node:child_process')"],
    ['a template-property getBuiltinModule', 'process[`getBuiltinModule`]("child_process")'],
    ['globalThis.process.getBuiltinModule', "globalThis.process.getBuiltinModule('child_process')"],
    [
      'literal properties on globalThis.process',
      "globalThis['process']['getBuiltinModule']('child_process')"
    ],
    [
      'an imported process',
      "import nodeProcess from 'node:process'\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'a named default-import process',
      "import { default as nodeProcess } from 'node:process'\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'an import-equals process',
      "import nodeProcess = require('node:process')\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'a destructured getBuiltinModule',
      "const { getBuiltinModule } = process\ngetBuiltinModule('child_process')"
    ],
    [
      'a quoted destructured getBuiltinModule',
      "const { 'getBuiltinModule': load } = process\nload('child_process')"
    ],
    [
      'a builtin module with a literal-property factory',
      "process['getBuiltinModule']('node:module')['createRequire'](__filename)('child_process')"
    ],
    [
      'an imported getBuiltinModule',
      "import { getBuiltinModule as load } from 'process'\nload('child_process')"
    ],
    [
      'a const specifier',
      "const CHILD_PROCESS = 'node:child_process' as const\nrequire(CHILD_PROCESS)"
    ],
    [
      'a const template specifier',
      'const CHILD_PROCESS = `child_process`\nprocess.getBuiltinModule(CHILD_PROCESS)'
    ]
  ])('resolves child_process loaded through %s', (_label, contents) => {
    expect(
      specifiers(contents).filter((specifier) => specifier.endsWith('child_process'))
    ).toHaveLength(1)
  })

  it('ignores unrelated objects, computed property values, and non-constant specifiers', () => {
    expect(
      specifiers(
        [
          'const registry = { getBuiltinModule: (name) => name, createRequire: () => () => null }',
          "registry.getBuiltinModule('child_process')",
          "registry.createRequire(__filename)('child_process')",
          "registry['getBuiltinModule']('child_process')",
          "registry['createRequire'](__filename)('child_process')",
          "const method = 'getBuiltinModule'",
          "process[method]('child_process')",
          "let mutable = 'child_process'",
          'require(mutable)',
          "require('child' + '_process')",
          "const name = 'child'",
          'require(`${name}_process`)'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('flags a new production file that bypasses the import form', () => {
    expect(
      assessProcessHostImports(
        new Map([
          [
            'src/main/bypass.ts',
            "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nload('child_process')"
          ],
          ['src/main/builtin.ts', "process['getBuiltinModule']('node:child_process')"],
          [
            'src/main/import-equals.ts',
            "import Module = require('node:module')\nconst load = Module.createRequire(__filename)\nload('node:child_process')"
          ],
          [
            'src/main/named-default-module.ts',
            "import { default as Module } from 'node:module'\nModule.createRequire(__filename)('child_process')"
          ],
          [
            'src/main/named-default-process.ts',
            "import { default as nodeProcess } from 'node:process'\nnodeProcess.getBuiltinModule('child_process')"
          ]
        ]),
        { exports: {} },
        []
      ).added
    ).toEqual([
      'src/main/builtin.ts',
      'src/main/bypass.ts',
      'src/main/import-equals.ts',
      'src/main/named-default-module.ts',
      'src/main/named-default-process.ts'
    ])
  })

  it.each([
    "import { createRequire } from 'node:module'\nconst ELECTRON = 'electron'\ncreateRequire(__filename)(ELECTRON)",
    "import Module = require('node:module')\nModule.createRequire(__filename)('electron')",
    "import { Module as HostModule } from 'module'\nHostModule.createRequire(__filename)('electron')",
    "import * as Module from 'node:module'\nModule['createRequire'](__filename)('electron')",
    "const { 'createRequire': make } = require('node:module')\nmake(__filename)('electron')"
  ])('applies package dependency rules to dynamically loaded specifiers: %s', (contents) => {
    expect(
      assessProcessHostImports(
        new Map([['src/packages/process-host/src/runner.ts', contents]]),
        { exports: {} },
        []
      ).violations
    ).toEqual([
      'src/packages/process-host/src/runner.ts: undeclared process-host dependency: electron'
    ])
  })
})
