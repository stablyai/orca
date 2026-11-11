import { transitionSessionSearchRetry } from './session-search-retry-transition'
import type {
  SessionSearchCatalog,
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult
} from './session-search-catalog'
import { transitionSessionSearchAuthority } from './session-search-observation-authority'
import { transitionSessionSearchDirty } from './session-search-dirty-transition'
import { transitionSessionSearchDependencyFanout } from './session-search-dependency-fanout'
import { transitionSessionSearchDirectoryFrontier } from './session-search-directory-frontier'
import { transitionSessionSearchFrontier } from './session-search-frontier-transition'
import { transitionSessionSearchContainer } from './session-search-container-transition'
import { transitionSessionSearchDependency } from './session-search-dependency-transition'
import { transitionSessionSearchDirectory } from './session-search-directory-transition'
import { transitionSessionSearchInventory } from './session-search-inventory-transition'

export function transitionSessionSearchCatalog(
  catalog: SessionSearchCatalog,
  command: SessionSearchCatalogCommand
): SessionSearchCatalogResult | undefined {
  switch (command.kind) {
    case 'retry-fail':
    case 'retry-remove':
    case 'retry-require':
    case 'retry-wake':
    case 'retry-admit':
      return transitionSessionSearchRetry(catalog, command)
    case 'authority-probe':
    case 'authority-probe-end':
    case 'authority-open':
    case 'directory-begin':
    case 'directory-stage':
    case 'directory-seal':
    case 'directory-end':
    case 'authority-cleanup':
      return transitionSessionSearchAuthority(catalog, command)
    case 'container-apply':
    case 'container-drain':
    case 'container-ack':
    case 'container-retirement-ack':
    case 'container-retire':
      return transitionSessionSearchContainer(catalog, command)
    case 'input-invalidate':
    case 'dirty-page':
    case 'dirty-ack': {
      catalog.connection.exec('SAVEPOINT search_dirty_transition')
      try {
        const result = transitionSessionSearchDirty(catalog, command)
        catalog.connection.exec('RELEASE search_dirty_transition')
        return result
      } catch (error) {
        catalog.connection.exec(
          'ROLLBACK TO search_dirty_transition; RELEASE search_dirty_transition'
        )
        throw error
      }
    }
    case 'dependency-remove':
    case 'dependency-deliver':
    case 'dependency-fanout':
    case 'dependency-discard':
      return transitionSessionSearchDependencyFanout(catalog, command)
    case 'dependency-step':
      return transitionSessionSearchDependency(catalog, command)
    case 'directory-schedule':
    case 'directory-cancel-step':
      return transitionSessionSearchDirectoryFrontier(catalog, command)
    case 'directory-step':
      return transitionSessionSearchDirectory(catalog, command)
    case 'frontier-snapshot':
    case 'frontier-settle':
    case 'frontier-set':
    case 'frontier-set-page':
    case 'frontier-move':
    case 'frontier-wake':
    case 'frontier-ack':
    case 'ack-values':
      return transitionSessionSearchFrontier(catalog, command)
    case 'observe-prepare':
    case 'observe-apply':
    case 'observe-ack':
    case 'forget-files': {
      const records =
        command.kind === 'observe-prepare'
          ? command.inputs
          : command.kind === 'observe-apply'
            ? command.outcomes
            : command.kind === 'observe-ack'
              ? command.receipts
              : command.paths
      if (
        records.length > 256 ||
        (records.length > 1 && JSON.stringify(command).length * 2 > 256 * 1024)
      ) {
        throw new Error('Session observation exceeds page budget')
      }
      catalog.connection.exec('SAVEPOINT search_inventory_transition')
      try {
        const result = transitionSessionSearchInventory(catalog, command)
        catalog.connection.exec('RELEASE search_inventory_transition')
        return result
      } catch (error) {
        catalog.connection.exec(
          'ROLLBACK TO search_inventory_transition; RELEASE search_inventory_transition'
        )
        throw error
      }
    }
    default:
      return undefined
  }
}
