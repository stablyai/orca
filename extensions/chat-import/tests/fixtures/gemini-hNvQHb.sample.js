// tests/fixtures/gemini-hNvQHb.sample.js
// 확정 hNvQHb 구조를 가명 데이터로 재현(개인정보 없음). 턴은 시간 역순으로 배치.
// turn = [ ["c_id","r_id"], ["c_id","r_id","rc_id"],
//          [[USER_TEXT],2,null,1,"sid",0,null,null,true],   // 사용자: turn[2][0][0]
//          [[["rc_id",[MODEL_TEXT],[],null,null,null,true,null]]], // 모델: turn[3][0][0][1][0]
//          [TS_EPOCH_SEC, 0] ]                               // 타임스탬프: turn[4][0]
function turn(userText, modelText, ts, n) {
  return [
    ['c_1', 'r_' + n],
    ['c_1', 'r_' + n, 'rc_' + n],
    [[userText], 2, null, 1, 'sid', 0, null, null, true],
    [[['rc_' + n, [modelText], [], null, null, null, true, null]]],
    [ts, 0]
  ]
}
// 시간 역순: 최신(질문2/답변2)이 먼저, 오래된(질문1/답변1)이 뒤.
const inner = [
  [turn('질문2', '답변2', 1782405788, 'b'), turn('질문1', '답변1', 1782405400, 'a')],
  null,
  null,
  null
]
const SAMPLE_RAW =
  ")]}'\n\n123\n" +
  JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner), null, null, null, 'generic']])
module.exports = {
  SAMPLE_RAW,
  EXPECT: {
    roles: ['USER', 'AI', 'USER', 'AI'],
    texts: ['질문1', '답변1', '질문2', '답변2'], // 시간순(역순 배열을 뒤집은 결과)
    firstCreatedAt: new Date(1782405400 * 1000).toISOString()
  }
}
