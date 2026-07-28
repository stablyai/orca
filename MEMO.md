# MEMO

## Changelog Memo

### 2026-07-28

- [新增] 为 #10162 的替代 Draft 实现原生修订事务和统一确认/幂等输入队列。
- [修复] 日文、韩文组合文本不再依赖时间窗口或补发 DEL；断线后的不确定发送使用同一序号重试。
- [验证] Mobile 2,581 项测试、TypeScript、lint、变更质量门槛及 iOS/Android 原生模块编译通过；详见 `CHANGELOG.md`。
- [未验证] 实体 iOS/Android 日文、韩文、高延迟重连及与 #10447 硬件键盘组合矩阵；完成前保持 Draft。
