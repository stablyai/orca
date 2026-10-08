import {
  ManagedServerRecover,
  ManagedServerSelector,
  ManagedServerUpdate
} from '../../../../shared/rpc-contract/managed-server-params'
import {
  getManagedServerActions,
  type ManagedServerActions
} from '../../managed-server-actions-registry'
import { defineMethod } from '../core'

// Why a refusal and not a crash: only the desktop main process registers these actions, and a
// client must read their absence the same way it reads an older host's method_not_found.
function actions(): ManagedServerActions {
  const registered = getManagedServerActions()
  if (!registered) {
    throw new Error('managed_server_unavailable')
  }
  return registered
}

export const MANAGED_SERVER_METHODS = [
  defineMethod({
    name: 'managedServer.status',
    params: ManagedServerSelector,
    handler: ({ selector }) => actions().status(selector)
  }),
  defineMethod({
    name: 'managedServer.update',
    params: ManagedServerUpdate,
    handler: ({ selector, force }) => actions().update(selector, force === true)
  }),
  defineMethod({
    name: 'managedServer.rollback',
    params: ManagedServerSelector,
    handler: ({ selector }) => actions().rollback(selector)
  }),
  defineMethod({
    name: 'managedServer.recover',
    params: ManagedServerRecover,
    handler: ({ selector, acceptChangedState }) =>
      actions().recover(selector, acceptChangedState === true)
  }),
  defineMethod({
    name: 'managedServer.stop',
    params: ManagedServerSelector,
    handler: ({ selector }) => actions().stop(selector)
  }),
  defineMethod({
    name: 'managedServer.cancelStop',
    params: ManagedServerSelector,
    handler: ({ selector }) => actions().cancelStop(selector)
  })
] as const
