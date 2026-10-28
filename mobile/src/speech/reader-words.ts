import { voiceNativeModule } from './voice-native-module'

/**
 * Cues the reader says itself, in the reading voice's language rather than the phone's, so a voice
 * never reads them in a foreign language. Orca's desktop languages plus Polish; else English.
 */
export type ReaderWords = {
  code: string
  table: string
  link: string
  waitQuestion: string
  waitPermission: string
  waitOther: string
  sample: string
}

export const READER_WORDS = {
  en: {
    code: 'Code block skipped.',
    table: 'Table skipped.',
    link: 'link',
    waitQuestion: 'The agent has a question.',
    waitPermission: 'The agent asks for permission.',
    waitOther: 'The agent is waiting for you.',
    sample: 'Test reading replies aloud.'
  },
  pl: {
    code: 'Pomijam fragment kodu.',
    table: 'Pomijam tabelę.',
    link: 'link',
    waitQuestion: 'Agent ma pytanie.',
    waitPermission: 'Agent prosi o zgodę.',
    waitOther: 'Agent czeka na ciebie.',
    sample: 'Test czytania odpowiedzi.'
  },
  es: {
    code: 'Bloque de código omitido.',
    table: 'Tabla omitida.',
    link: 'enlace',
    waitQuestion: 'El agente tiene una pregunta.',
    waitPermission: 'El agente pide permiso.',
    waitOther: 'El agente te está esperando.',
    sample: 'Prueba de lectura de respuestas.'
  },
  fr: {
    code: 'Bloc de code ignoré.',
    table: 'Tableau ignoré.',
    link: 'lien',
    waitQuestion: "L'agent a une question.",
    waitPermission: "L'agent demande une autorisation.",
    waitOther: "L'agent vous attend.",
    sample: 'Test de lecture des réponses.'
  },
  pt: {
    code: 'Bloco de código omitido.',
    table: 'Tabela omitida.',
    link: 'link',
    waitQuestion: 'O agente tem uma pergunta.',
    waitPermission: 'O agente pede permissão.',
    waitOther: 'O agente está esperando por você.',
    sample: 'Teste de leitura das respostas.'
  },
  zh: {
    code: '已跳过代码块。',
    table: '已跳过表格。',
    link: '链接',
    waitQuestion: '智能体有一个问题。',
    waitPermission: '智能体正在请求权限。',
    waitOther: '智能体正在等你。',
    sample: '朗读回复测试。'
  },
  ja: {
    code: 'コードブロックを省略しました。',
    table: '表を省略しました。',
    link: 'リンク',
    waitQuestion: 'エージェントから質問があります。',
    waitPermission: 'エージェントが許可を求めています。',
    waitOther: 'エージェントが待っています。',
    sample: '返信の読み上げテストです。'
  },
  ko: {
    code: '코드 블록을 건너뜁니다.',
    table: '표를 건너뜁니다.',
    link: '링크',
    waitQuestion: '에이전트에게 질문이 있습니다.',
    waitPermission: '에이전트가 권한을 요청합니다.',
    waitOther: '에이전트가 기다리고 있습니다.',
    sample: '답변 읽기 테스트입니다.'
  }
} satisfies Record<string, ReaderWords>

export type ReaderLanguage = keyof typeof READER_WORDS

function isReaderLanguage(tag: string): tag is ReaderLanguage {
  return Object.hasOwn(READER_WORDS, tag)
}

function supported(tag: string | null): ReaderLanguage | null {
  const primary = (tag?.split(/[-_]/)[0] ?? '').toLowerCase()
  return isReaderLanguage(primary) ? primary : null
}

/**
 * A known voice language wins even without words here: English suits an Italian voice better than
 * the phone's Polish would. The phone's locale only stands in until the voice's is known.
 */
export function pickReaderLanguage(
  voiceLanguage: string | null,
  phoneLocale: string | null
): ReaderLanguage {
  if (voiceLanguage) {
    return supported(voiceLanguage) ?? 'en'
  }
  return supported(phoneLocale) ?? 'en'
}

function phoneLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return null
  }
}

let engineStarted = false

/** What the native reader last reported reading in; null until its engine has run once. */
export function voiceLanguage(): string | null {
  const native = voiceNativeModule()
  const language = native?.getSpeechOptions()?.language ?? null
  if (native && language === null && !engineStarted) {
    engineStarted = true
    // Starting the engine records its language, so the next reading knows it.
    void native.getVoices().catch(() => null)
  }
  return language
}

export function readerLanguage(): ReaderLanguage {
  return pickReaderLanguage(voiceLanguage(), phoneLocale())
}

export function readerWords(language = readerLanguage()): ReaderWords {
  return READER_WORDS[language]
}
