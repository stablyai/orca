import { readRuntimeMetadata } from './orca-rpc-client/runtime-metadata.js';
import { callOrca } from './orca-rpc-client/pipe-transport.js';

async function testConnection() {
  console.log('🔍 Đang kiểm tra kết nối tới Orca Runtime...');

  try {
    const meta = readRuntimeMetadata();
    console.log('✅ Đọc thành công metadata:');
    console.log(`   - PID: ${meta.pid}`);
    console.log(`   - RuntimeId: ${meta.runtimeId}`);
    console.log(`   - AuthToken: ${meta.authToken ? '***' + meta.authToken.slice(-6) : 'null'}`);
    console.log(`   - Transports:`, meta.transports);

    const pipeTransport = meta.transports.find(t => t.kind === 'named-pipe');
    if (!pipeTransport) {
      console.warn('⚠️ Không tìm thấy Named Pipe transport trong metadata.');
      return;
    }

    console.log(`\n📡 Đang gửi lệnh test "status.get" qua Named Pipe (${pipeTransport.endpoint})...`);
    const status = await callOrca('status.get', {});
    console.log('🎉 KẾT NỐI THÀNH CÔNG VỚI ORCA DESKTOP!');
    console.log('Kết quả status.get:', JSON.stringify(status, null, 2));

  } catch (err) {
    console.error('❌ Lỗi kết nối:', err.message);
    console.log('\n💡 Gợi ý: Hãy đảm bảo ứng dụng Orca Desktop (C:\\Users\\Admim\\AppData\\Local\\Programs\\orca\\Orca.exe) đang được mở.');
  }
}

testConnection();
