import {
  PairedE2EEV2ClientSession,
  type PairedE2EEV2ClientSessionArgs
} from '../../../src/shared/remote-runtime/e2ee/paired-e2ee-v2-client-session'
import { MOBILE_PAIRED_E2EE_PRIMITIVES } from './mobile-paired-e2ee-primitives'

export const MobileE2EEV2ClientSession = {
  create: (args: Omit<PairedE2EEV2ClientSessionArgs, 'primitives'>): PairedE2EEV2ClientSession =>
    PairedE2EEV2ClientSession.create({ ...args, primitives: MOBILE_PAIRED_E2EE_PRIMITIVES })
}
