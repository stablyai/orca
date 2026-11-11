import type { SpeechModelDownloadFile } from '../../shared/speech-types'

type GgufDownload = readonly [
  repository: string,
  revision: string,
  name: string,
  sizeBytes: number,
  sha256: string
]

// handy-computer's GGUF conversions for transcribe-cpp 0.4.x, pinned by revision and hash.
const GGUF_DOWNLOADS = {
  'parakeet-tdt-0.6b-v3-int8': [
    'handy-computer/parakeet-tdt-0.6b-v3-gguf',
    '85ac09ea12fc4b1112fa76810059364bc6adc9de',
    'parakeet-tdt-0.6b-v3-Q8_0.gguf',
    739_508_576,
    '5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7'
  ],
  'parakeet-tdt-0.6b-v2-int8': [
    'handy-computer/parakeet-tdt-0.6b-v2-gguf',
    '07cee0616125a08ef619729bb47f40ef747e4bc4',
    'parakeet-tdt-0.6b-v2-Q8_0.gguf',
    729_574_912,
    'f0d0e99cebb6d3b83f1f7069b82b5d3c2e39a54545b0da039cb4bafd9c4e5caa'
  ],
  'whisper-tiny': [
    'handy-computer/whisper-tiny-gguf',
    '6687f30c99641ee265df421e582354adbc8848fc',
    'whisper-tiny-Q8_0.gguf',
    45_981_088,
    '325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834'
  ],
  'whisper-large-v3-turbo': [
    'handy-computer/whisper-large-v3-turbo-gguf',
    '5eaf945c7978e564bae5b28a5b1639dd93c2bfb1',
    'whisper-large-v3-turbo-Q8_0.gguf',
    886_381_760,
    'b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183'
  ],
  'sense-voice-zh-en-ja-ko-yue': [
    'handy-computer/SenseVoiceSmall-gguf',
    '4a08b8e900b38a977e32eb08d5d0697d6e72ba04',
    'SenseVoiceSmall-Q8_0.gguf',
    252_684_608,
    '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29'
  ],
  'nemotron-3.5-asr-streaming-0.6b': [
    'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf',
    '6d44e540bc31b0de1dbe174a3cea87f53a7f22fb',
    'nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
    751_094_240,
    'b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c'
  ],
  'gigaam-v3-ctc-punct-ru-int8': [
    'handy-computer/gigaam-v3-e2e-ctc-gguf',
    '59717de63d50dd9dd93b3249da6ad3f2f1c4ad6b',
    'gigaam-v3-e2e-ctc-Q8_0.gguf',
    272_151_136,
    '9ccce4750dc813a493d96ca15ee251712bedec15ac9a02fa3d2bd732f08ae5eb'
  ]
} satisfies Record<string, GgufDownload>

export type GgufSpeechModelId = keyof typeof GGUF_DOWNLOADS

export function getGgufSpeechModelDownload(modelId: GgufSpeechModelId): {
  downloadFiles: SpeechModelDownloadFile[]
  files: string[]
  sizeBytes: number
} {
  const [repository, revision, name, sizeBytes, sha256] = GGUF_DOWNLOADS[modelId]
  const url = `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(name)}?download=true`
  return { downloadFiles: [{ name, url, sizeBytes, sha256 }], files: [name], sizeBytes }
}
