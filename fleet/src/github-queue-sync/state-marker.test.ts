import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStateMarker, renderStateMarker } from './state-marker.ts';

describe('state marker', () => {
  it('render rồi parse ra đúng giá trị', () => {
    const state = { dispatch: 'ctx_1', iteration: 3, worktree: 'gh-142-fix' };
    assert.deepEqual(parseStateMarker(`trước\n${renderStateMarker(state)}\nsau`), state);
  });

  it('giá trị chứa `-->` không đóng comment HTML sớm và vẫn parse lại được', () => {
    const state = { dispatch: 'a-->b', iteration: 0, worktree: 'x' };
    const marker = renderStateMarker(state);
    assert.equal(marker.indexOf('-->'), marker.length - 3, 'chỉ đúng một `-->` ở cuối');
    assert.deepEqual(parseStateMarker(marker), state);
  });

  it('không có marker → undefined', () => {
    assert.equal(parseStateMarker('chỉ là comment thường'), undefined);
  });

  it('marker bị người sửa hỏng (JSON sai, thiếu trường, sai kiểu) → undefined, không ném lỗi', () => {
    assert.equal(parseStateMarker('<!-- orca-fleet:state {oops} -->'), undefined);
    assert.equal(parseStateMarker('<!-- orca-fleet:state {"dispatch":"d"} -->'), undefined);
    assert.equal(parseStateMarker('<!-- orca-fleet:state {"dispatch":"d","iteration":"3","worktree":"w"} -->'), undefined);
    assert.equal(parseStateMarker('<!-- orca-fleet:state {"dispatch":"d","iteration":1.5,"worktree":"w"} -->'), undefined);
  });
});
