/**
 * The runtime-RPC face of the bridge: paired clients drive relay-era panes through these.
 * Served through the orcad conversion seam; the registry itself answers empty/not-bridged.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  SshLegacyRelayPane,
  SshLegacyRelayPaneDetach,
  SshLegacyRelayPaneOutputPaused,
  SshLegacyRelayPaneResize,
  SshLegacyRelayPaneWrite
} from '../../../../shared/rpc-contract/ssh/ssh-params'
import {
  attachLegacyRelayPane,
  closeLegacyRelayPane,
  detachLegacyRelayPane,
  legacyRelayBridgedPanes,
  resizeLegacyRelayPane,
  setLegacyRelayPaneOutputPaused,
  writeLegacyRelayPane
} from './legacy-relay-bridge-registry'
import { defineMethod } from '../../../runtime/rpc/core'

// Why host-admin: every channel reaches a remote shell, so paired clients need the same
// authority as ssh.connect; the registry itself answers empty/not-bridged when no bridge runs.
export const SSH_LEGACY_RELAY_BRIDGE_METHODS = [
  defineMethod({
    name: 'ssh.listLegacyRelayBridgedPanes',
    permission: 'host-admin',
    params: null,
    handler: () => ({ panes: legacyRelayBridgedPanes() })
  }),
  defineMethod({
    name: 'ssh.attachLegacyRelayBridgedPane',
    permission: 'host-admin',
    params: SshLegacyRelayPane,
    handler: async (params) => attachLegacyRelayPane(params.ptyId)
  }),
  defineMethod({
    name: 'ssh.detachLegacyRelayBridgedPane',
    permission: 'host-admin',
    params: SshLegacyRelayPaneDetach,
    handler: (params) => {
      if (params.acquisitionId !== undefined) {
        detachLegacyRelayPane(params.ptyId, params.acquisitionId)
      }
      return { detached: true }
    }
  }),
  defineMethod({
    name: 'ssh.closeLegacyRelayBridgedPane',
    permission: 'host-admin',
    params: SshLegacyRelayPane,
    handler: async (params) => closeLegacyRelayPane(params.ptyId)
  }),
  defineMethod({
    name: 'ssh.writeLegacyRelayBridgedPane',
    permission: 'host-admin',
    params: SshLegacyRelayPaneWrite,
    handler: (params) => {
      writeLegacyRelayPane(params.ptyId, params.data)
      return { written: true }
    }
  }),
  defineMethod({
    name: 'ssh.resizeLegacyRelayBridgedPane',
    permission: 'host-admin',
    params: SshLegacyRelayPaneResize,
    handler: (params) => {
      resizeLegacyRelayPane(params.ptyId, params.cols, params.rows)
      return { resized: true }
    }
  }),
  defineMethod({
    name: 'ssh.setLegacyRelayBridgedPaneOutputPaused',
    permission: 'host-admin',
    params: SshLegacyRelayPaneOutputPaused,
    handler: (params) => {
      setLegacyRelayPaneOutputPaused(params.ptyId, params.paused)
      return { paused: params.paused }
    }
  })
]
