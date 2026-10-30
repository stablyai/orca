import {
  DEFAULT_HEADPHONES_ONLY,
  DEFAULT_LINK_READING,
  DEFAULT_TABLE_READING,
  HEADPHONES_ONLY_KEY,
  LANGUAGE_VOICES_KEY,
  DEFAULT_LANGUAGE_VOICES,
  LINK_READING_KEY,
  TABLE_READING_KEY,
  type HeadphonesOnly,
  type LanguageVoices,
  type LinkReading,
  type TableReading
} from '../storage/speech-preferences'
import { createStoredChoice } from './stored-choice'

export const useLinkReading = createStoredChoice<LinkReading>(
  LINK_READING_KEY,
  ['word-and-text', 'text', 'word-text-site', 'off'],
  DEFAULT_LINK_READING
)

export const useTableReading = createStoredChoice<TableReading>(
  TABLE_READING_KEY,
  ['with-headers', 'values', 'skip'],
  DEFAULT_TABLE_READING
)

// Auto-read only through headphones or a car, so the phone never talks aloud in an office or shop.
export const useHeadphonesOnly = createStoredChoice<HeadphonesOnly>(
  HEADPHONES_ONLY_KEY,
  ['on', 'off'],
  DEFAULT_HEADPHONES_ONLY
)

export const useLanguageVoices = createStoredChoice<LanguageVoices>(
  LANGUAGE_VOICES_KEY,
  ['on', 'off'],
  DEFAULT_LANGUAGE_VOICES
)
