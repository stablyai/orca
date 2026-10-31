/** The main-process plugin checks `orca plugin validate|inspect` runs. One CLI entry so the
 *  packaged CLI loads them after electron-vite replaces out/main; keep it free of Electron. */
export {
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent
} from './plugin-artifact-validation'
export { hashPluginTree } from './plugin-content-hash'
