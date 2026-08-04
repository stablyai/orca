import type { SpeechModelDownloadFile } from '../../shared/speech-types'

type DownloadFileSpec = readonly [name: string, sizeBytes: number, sha256: string]

function huggingFaceFiles(
  repository: string,
  revision: string,
  specs: DownloadFileSpec[]
): SpeechModelDownloadFile[] {
  return specs.map(([name, sizeBytes, sha256]) => ({
    name,
    url: `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(name)}?download=true`,
    sizeBytes,
    sha256
  }))
}

// Why: immutable revisions plus per-file hashes keep direct downloads equivalent to pinned archives.
const MODEL_DOWNLOAD_FILES = {
  'parakeet-tdt-0.6b-v3-int8': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    '2bda32ec70b097a55adaa07d9a7173915b43cc78',
    [
      [
        'encoder.int8.onnx',
        652_184_281,
        'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'
      ],
      [
        'decoder.int8.onnx',
        11_845_275,
        '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'
      ],
      [
        'joiner.int8.onnx',
        6_355_277,
        '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'
      ],
      ['tokens.txt', 93_939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d']
    ]
  ),
  'parakeet-tdt-0.6b-v2-int8': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    '1ab9323565ddb038682214b292f588070a538ce2',
    [
      [
        'encoder.int8.onnx',
        652_184_296,
        'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab'
      ],
      [
        'decoder.int8.onnx',
        7_257_753,
        'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e'
      ],
      [
        'joiner.int8.onnx',
        1_739_080,
        '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2'
      ],
      ['tokens.txt', 9_384, 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d']
    ]
  ),
  'zipformer-bilingual-zh-en': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    '98590b7ed6443e77b714204da2757d75e1a642f4',
    [
      [
        'encoder-epoch-99-avg-1.onnx',
        330_083_505,
        '709f0ed53a734b7942f170127e7547b566cb29c4afc5e67719f314c3d63ccb10'
      ],
      [
        'decoder-epoch-99-avg-1.onnx',
        13_876_452,
        '2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d'
      ],
      [
        'joiner-epoch-99-avg-1.onnx',
        12_833_618,
        '5f2adc585dd1bec6421c8bb8660d2a73fc8b9ceb24491ef51399ba2a2f0fc31b'
      ],
      ['tokens.txt', 56_317, 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'],
      ['bpe.vocab', 12_564, 'd0b642f3a2eacd5fadefdeff9e0e1358cab729647cbb7fe58cf738e1f7407029']
    ]
  ),
  'paraformer-bilingual-zh-en': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    '8e40c43232a1c5c66c82111efc5820d3accca11b',
    [
      [
        'encoder.int8.onnx',
        165_462_184,
        '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a'
      ],
      [
        'decoder.int8.onnx',
        71_664_561,
        'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f'
      ],
      ['tokens.txt', 75_756, '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6']
    ]
  ),
  'zipformer-streaming-en-20m': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
    'd42f2d9f7ca24806fb667456a18a9f1b60f70d16',
    [
      [
        'encoder-epoch-99-avg-1.onnx',
        88_804_590,
        'f77a22f4ff94604e1afb2aeb13504d7699363528c047c97d3436087c95c9b659'
      ],
      [
        'decoder-epoch-99-avg-1.onnx',
        2_092_272,
        '45a7f940ecfb53d89fa270ad11b88b961e53a317203eb24b1c8e95ed208b0f30'
      ],
      [
        'joiner-epoch-99-avg-1.onnx',
        1_026_462,
        '343e17dffa4f386ca206e00d3c406908f68f473c3d35968d6c3cddd5b8559a94'
      ],
      ['tokens.txt', 5_048, '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb']
    ]
  ),
  'zipformer-streaming-zh-14m': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    '204ad334e2e683fd295359930cc16fc0432a23ac',
    [
      [
        'encoder-epoch-99-avg-1.onnx',
        40_948_171,
        '84c6a8f372686faa5b8f45f2d79f0816f76dcd9f547acb9a90eba2772d7eda8b'
      ],
      [
        'decoder-epoch-99-avg-1.onnx',
        7_509_745,
        '5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78'
      ],
      [
        'joiner-epoch-99-avg-1.onnx',
        7_109_975,
        '030212efaea9a8b6a4fa98faf6ac6055529c4408cf4865e898220ddd02780f34'
      ],
      ['tokens.txt', 48_697, '8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac']
    ]
  ),
  'zipformer-streaming-korean': huggingFaceFiles(
    'k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16',
    'ba6078bca4daf3f0dd37f79d0ab505af71df14a6',
    [
      [
        'encoder-epoch-99-avg-1.int8.onnx',
        126_968_852,
        '8d0b1aa24fbedd4e3948564ab7facd151b8ce9b0c48fc987c541de2de3af5697'
      ],
      [
        'decoder-epoch-99-avg-1.int8.onnx',
        2_844_692,
        '68ea197936aabd249f38b53a87c775422bca64428ad4427d0e6e8092593e71fb'
      ],
      [
        'joiner-epoch-99-avg-1.int8.onnx',
        2_581_421,
        '128b80a66a1f718488af8560f9d15895109b99ff3e573f0a0130e03774ef1ced'
      ],
      ['tokens.txt', 60_246, '016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668']
    ]
  ),
  'parakeet-tdt-ctc-0.6b-ja-int8': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8',
    'bef18eb066808c90bd0f5df5be685767b0732de8',
    [
      [
        'model.int8.onnx',
        655_542_604,
        '3addd00ef5bd1742078389e540b77394e4a508bdf2f4c9ad1b4a76d93e76598e'
      ],
      ['tokens.txt', 28_557, '732f64c53909f2620c713f4106b487d92e6f54a6915b3cd3d1dbd32f9f4f392a']
    ]
  ),
  'whisper-tiny': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-whisper-tiny',
    '65176e2deb88badc814a94058666cadccc29b61c',
    [
      [
        'tiny-encoder.onnx',
        37_647_080,
        '42c1d4cbf889632ba21ab6f0d4064c80209755f265ce5cd630db4a6793e7089c'
      ],
      [
        'tiny-decoder.onnx',
        114_505_801,
        'e144c07dc6b55cece24392811f2d934b97013811f5e677d1315d341a0a74a25d'
      ],
      [
        'tiny-tokens.txt',
        816_730,
        'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
      ]
    ]
  ),
  'sense-voice-zh-en-ja-ko-yue': huggingFaceFiles(
    'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    '2365baeacb507f821a0c8120fcee3d484dba7a07',
    [
      [
        'model.int8.onnx',
        239_233_841,
        'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
      ],
      ['tokens.txt', 315_894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc']
    ]
  )
}

export type DownloadableSpeechModelId = keyof typeof MODEL_DOWNLOAD_FILES

export function getSpeechModelDownloadMetadata(modelId: DownloadableSpeechModelId): {
  downloadFiles: SpeechModelDownloadFile[]
  files: string[]
  sizeBytes: number
} {
  const downloadFiles = MODEL_DOWNLOAD_FILES[modelId]
  return {
    downloadFiles,
    files: downloadFiles.map(({ name }) => name),
    sizeBytes: downloadFiles.reduce((total, { sizeBytes }) => total + sizeBytes, 0)
  }
}
