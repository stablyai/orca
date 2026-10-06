package dev.orca.automationproof;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketAddress;
import javax.net.SocketFactory;

// Only the transport changes; OkHttp owns HTTP and WebSocket framing.
final class LocalSocketFactory extends SocketFactory {
    private final String name;
    LocalSocketFactory(String name) { this.name = name; }
    @Override public Socket createSocket() { return new UnixSocket(name); }
    @Override public Socket createSocket(String h, int p) { throw new UnsupportedOperationException(); }
    @Override public Socket createSocket(String h, int p, InetAddress l, int lp) { throw new UnsupportedOperationException(); }
    @Override public Socket createSocket(InetAddress h, int p) { throw new UnsupportedOperationException(); }
    @Override public Socket createSocket(InetAddress h, int p, InetAddress l, int lp) { throw new UnsupportedOperationException(); }

    private static final class UnixSocket extends Socket {
        private final LocalSocket local = new LocalSocket();
        private final String name;
        private boolean closed;
        private int readTimeout;
        UnixSocket(String name) { this.name = name; }
        @Override public void connect(SocketAddress ignored, int timeout) throws IOException {
            local.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            local.setSoTimeout(readTimeout);
        }
        @Override public InputStream getInputStream() throws IOException { return local.getInputStream(); }
        @Override public OutputStream getOutputStream() throws IOException { return local.getOutputStream(); }
        @Override public void setSoTimeout(int timeout) throws java.net.SocketException {
            readTimeout = timeout;
            if (!local.isConnected()) return;
            try { local.setSoTimeout(timeout); }
            catch (IOException error) { throw new java.net.SocketException(error.toString()); }
        }
        @Override public int getSoTimeout() throws java.net.SocketException {
            return readTimeout;
        }
        @Override public boolean isConnected() { return local.isConnected(); }
        @Override public boolean isClosed() { return closed; }
        @Override public void close() throws IOException { closed = true; local.close(); }
        @Override public void shutdownInput() throws IOException { local.shutdownInput(); }
        @Override public void shutdownOutput() throws IOException { local.shutdownOutput(); }
    }
}
