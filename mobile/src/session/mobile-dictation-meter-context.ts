import { createContext } from 'react'
import type { MobileDictationMeter } from '../hooks/mobile-dictation-meter'

// The chat mic sits several composers deep (overlay, queued edits); it reads the live recording's meter from here.
export const MobileDictationMeterContext = createContext<MobileDictationMeter | null>(null)
