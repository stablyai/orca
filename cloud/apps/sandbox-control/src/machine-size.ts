// One sandbox size (U18): Standard = 8 vCPU / 16 GB, the most a Vercel Pro sandbox allows (16/32 needs
// Enterprise). `large` was that same box; old desktops and saved API configs may still send it, so
// every request schema accepts it and stores `standard` (migration 0040 rewrote existing rows).
import { z } from 'zod'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'

export const SANDBOX_VCPUS: number = ORCA_CLOUD_SANDBOX_SPEC.vcpus

export const MachineSizeInput = z.enum(['standard', 'large']).transform((): 'standard' => 'standard')
