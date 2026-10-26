import { OrcaRuntimeWithRuntimeId } from './runtime-identity-state'
import {
  RuntimeExternalParentLinks,
  type ExternalAgentParentLink
} from '../runtime-external-parent-links'

export abstract class OrcaRuntimeWithExternalParentLinks extends OrcaRuntimeWithRuntimeId {
  protected readonly externalAgentParentLinks = new RuntimeExternalParentLinks()

  setExternalAgentParentLink(childPaneKey: string, link: ExternalAgentParentLink): void {
    this.externalAgentParentLinks.set(childPaneKey, link)
  }

  clearExternalAgentParentLink(childPaneKey: string): void {
    this.externalAgentParentLinks.delete(childPaneKey)
  }
}
