import { TestRunner } from 'vitest'

export default class SharedWorkerSetupRunner extends TestRunner {
  importFile(filepath, source) {
    if (source === 'setup') {
      // Warm transforms can key setup roots by a different URL than Vitest invalidates.
      const modules = this.moduleRunner.evaluatedModules
      for (const node of modules.getModulesByFile(filepath) ?? []) {
        if (node.evaluated) {
          modules.invalidateModule(node)
        }
      }
    }
    return super.importFile(filepath, source)
  }
}
