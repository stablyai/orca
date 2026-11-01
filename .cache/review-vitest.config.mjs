import { realpathSync } from 'node:fs'
import base from '../config/vitest.config.ts'
const server = { fs: { allow: [process.cwd(), realpathSync('node_modules/vscode-oniguruma')] } }
export default {
  ...base,
  server,
  test: { ...base.test, projects: base.test.projects.map(project => ({ ...project, server })) }
}
