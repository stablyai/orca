import {
  PairedE2EEV2ClientSession,
  type PairedE2EEV2ClientSessionArgs
} from '../../../src/shared/paired-e2ee-v2-client-session'
import { MOBILE_PAIRED_E2EE_PRIMITIVES } from './mobile-paired-e2ee-primitives'

export type MobileE2EEV2ClientSession = PairedE2EEV2ClientSession

export const MobileE2EEV2ClientSession = {
  create: (args: Omit<PairedE2EEV2ClientSessionArgs, 'primitives'>): MobileE2EEV2ClientSession =>
    PairedE2EEV2ClientSession.create({ ...args, primitives: MOBILE_PAIRED_E2EE_PRIMITIVES })
}
